package com.kamedono.mydatabase;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 画面のどこにいても押せる「本アイコン」を常駐表示するフォアグラウンドサービス。
 * タップすると、別の画面に移動せず、その場でカード状の入力欄を展開する。
 * 保存は隠しWebView(overlaybridge.html)経由で、既存アプリと同じIndexedDBに書き込む。
 */
public class OverlayBubbleService extends Service {

    public static final String CHANNEL_ID = "overlay_bubble_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final int TAP_MOVE_THRESHOLD_PX = 18;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private WindowManager windowManager;

    private View bubbleView;
    private WindowManager.LayoutParams bubbleParams;
    private boolean bubbleAdded = false;

    private View cardView;
    private WindowManager.LayoutParams cardParams;
    private boolean cardAdded = false;

    private WebView bridgeWebView;
    private boolean bridgeReady = false;
    private Runnable pendingBridgeAction;

    private int nextRequestId = 1;
    private final Map<Integer, java.util.function.Consumer<Boolean>> pendingSaveCallbacks = new HashMap<>();
    private final Map<Integer, java.util.function.Consumer<List<String>>> pendingTagCallbacks = new HashMap<>();

    private SpeechRecognizer speechRecognizer;
    private EditText activeInputForSpeech;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification());
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        setupBridgeWebView();
        addBubbleView();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        removeBubbleView();
        if (cardAdded && cardView != null) {
            try {
                windowManager.removeView(cardView);
            } catch (IllegalArgumentException ignored) {
            }
            cardAdded = false;
        }
        if (bridgeWebView != null) {
            bridgeWebView.destroy();
        }
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
        }
    }

    // ---- 通知(フォアグラウンドサービスに必須) ----

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "常駐メモアイコン",
                NotificationManager.IMPORTANCE_MIN
            );
            channel.setDescription("画面に常駐するメモ追加アイコンを表示しています");
            manager.createNotificationChannel(channel);
        }

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        return builder
            .setContentTitle("ピックノート")
            .setContentText("常駐メモアイコンが有効です")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setOngoing(true)
            .build();
    }

    // ---- 保存用の隠しWebView ----

    /**
     * JS側(overlaybridge.html)からの結果報告を受け取る窓口。
     * evaluateJavascriptの戻り値は__overlaySaveがasync関数である以上あてにならない
     * (Promiseは同期的な戻り値としては捕捉できずnullになる)ため、
     * 実際の保存完了・失敗はこちらのJavascriptInterface経由で明示的に受け取る。
     */
    private class JsBridge {
        @JavascriptInterface
        public void onSaveResult(int requestId, boolean ok, String message) {
            mainHandler.post(() -> {
                java.util.function.Consumer<Boolean> callback = pendingSaveCallbacks.remove(requestId);
                if (callback != null) callback.accept(ok);
            });
        }

        @JavascriptInterface
        public void onTagsResult(int requestId, String namesJson) {
            mainHandler.post(() -> {
                java.util.function.Consumer<List<String>> callback = pendingTagCallbacks.remove(requestId);
                if (callback == null) return;
                List<String> names = new ArrayList<>();
                try {
                    JSONArray arr = new JSONArray(namesJson);
                    for (int i = 0; i < arr.length(); i++) names.add(arr.getString(i));
                } catch (Exception ignored) {
                }
                callback.accept(names);
            });
        }
    }

    /**
     * 本体アプリ(Capacitorのデフォルト設定)は https://localhost というoriginでWebViewを動かしている。
     * この隠しWebViewを file:// で読み込むと別originになり、IndexedDBが本体と共有されない
     * (2026-09-16に発覚した「保存しましたと出るのに実際は保存されない」不具合の根本原因)。
     * WebViewAssetLoaderで同じ https://localhost origin から配信することで、同じIndexedDBに
     * 書き込めるようにする。
     */
    private void setupBridgeWebView() {
        // プレフィックスは"/"(ルート)にする。AssetsPathHandlerはマッチしたプレフィックスを
        // 取り除いた残りのパスをそのままassets/配下の相対パスとして開くため、
        // "/public/"にすると実際のassets/public/配下ではなくassets/直下を探してしまい、
        // ファイルが見つからなくなる(assets/public/overlaybridge.htmlを開きたいので、
        // リクエストパス全体"public/overlaybridge.html"をそのまま渡す必要がある)。
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        bridgeWebView = new WebView(this);
        bridgeWebView.getSettings().setJavaScriptEnabled(true);
        bridgeWebView.getSettings().setDomStorageEnabled(true);
        bridgeWebView.getSettings().setDatabaseEnabled(true);
        bridgeWebView.addJavascriptInterface(new JsBridge(), "AndroidBridge");
        bridgeWebView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bridgeReady = true;
                if (pendingBridgeAction != null) {
                    Runnable action = pendingBridgeAction;
                    pendingBridgeAction = null;
                    action.run();
                }
            }
        });
        bridgeWebView.loadUrl("https://localhost/public/overlaybridge.html");

        // 画面には映さないが、WebViewが正しく動くにはウィンドウに追加されている必要がある
        WindowManager.LayoutParams hiddenParams = new WindowManager.LayoutParams(
            1,
            1,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        );
        hiddenParams.gravity = Gravity.TOP | Gravity.START;
        try {
            windowManager.addView(bridgeWebView, hiddenParams);
        } catch (Exception ignored) {
            // オーバーレイ権限が無い等で失敗した場合でも致命的にはしない
        }
    }

    private void fetchExistingTags(java.util.function.Consumer<List<String>> onDone) {
        int requestId = nextRequestId++;
        pendingTagCallbacks.put(requestId, onDone);
        Runnable attempt = () -> bridgeWebView.evaluateJavascript(
            "window.__overlayGetTags(" + requestId + ")", null
        );
        if (bridgeReady) {
            attempt.run();
        } else {
            Runnable previous = pendingBridgeAction;
            pendingBridgeAction = () -> {
                if (previous != null) previous.run();
                attempt.run();
            };
        }
        mainHandler.postDelayed(() -> {
            java.util.function.Consumer<List<String>> stillPending = pendingTagCallbacks.remove(requestId);
            if (stillPending != null) stillPending.accept(new ArrayList<>());
        }, 5000);
    }

    /**
     * ブリッジの読み込みが終わっていなければ、終わるまで保存要求を1件だけ保留する
     * (連打された場合は最後の1件が勝つ想定で十分)。
     */
    private void saveNote(String title, String content, List<String> tags, java.util.function.Consumer<Boolean> onDone) {
        int requestId = nextRequestId++;
        pendingSaveCallbacks.put(requestId, onDone);

        Runnable attempt = () -> {
            JSONArray tagsArray = new JSONArray();
            for (String t : tags) tagsArray.put(t);
            String js = "window.__overlaySave(" + requestId + ","
                + JSONObject.quote(title) + ","
                + JSONObject.quote(content) + ","
                + tagsArray.toString() + ")";
            bridgeWebView.evaluateJavascript(js, null);
        };

        if (bridgeReady) {
            attempt.run();
        } else {
            pendingBridgeAction = attempt;
        }

        // ブリッジ自体が権限問題などで永久に準備できない場合に、無反応のままにしないための保険。
        mainHandler.postDelayed(() -> {
            java.util.function.Consumer<Boolean> stillPending = pendingSaveCallbacks.remove(requestId);
            if (stillPending != null) stillPending.accept(false);
        }, 8000);
    }

    private int overlayType() {
        return (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
    }

    // ---- ふきだしアイコン(たたんだ状態) ----

    private void addBubbleView() {
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_bubble_book);
        icon.setBackgroundResource(R.drawable.bg_bubble_circle);
        int paddingPx = dpToPx(14);
        icon.setPadding(paddingPx, paddingPx, paddingPx, paddingPx);
        bubbleView = icon;

        bubbleParams = new WindowManager.LayoutParams(
            dpToPx(48),
            dpToPx(48),
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = 0;
        bubbleParams.y = dpToPx(160);

        windowManager.addView(bubbleView, bubbleParams);
        bubbleAdded = true;

        bubbleView.setOnTouchListener(new View.OnTouchListener() {
            private int initialX;
            private int initialY;
            private float initialTouchX;
            private float initialTouchY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        initialX = bubbleParams.x;
                        initialY = bubbleParams.y;
                        initialTouchX = event.getRawX();
                        initialTouchY = event.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (event.getRawX() - initialTouchX);
                        int dy = (int) (event.getRawY() - initialTouchY);
                        if (Math.abs(dx) > TAP_MOVE_THRESHOLD_PX || Math.abs(dy) > TAP_MOVE_THRESHOLD_PX) {
                            moved = true;
                        }
                        bubbleParams.x = initialX + dx;
                        bubbleParams.y = initialY + dy;
                        if (bubbleAdded) windowManager.updateViewLayout(bubbleView, bubbleParams);
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            expandCard();
                        }
                        return true;
                }
                return false;
            }
        });
    }

    private void removeBubbleView() {
        if (bubbleAdded && bubbleView != null) {
            try {
                windowManager.removeView(bubbleView);
            } catch (IllegalArgumentException ignored) {
            }
            bubbleAdded = false;
        }
    }

    // ---- クイック入力カード(展開した状態) ----

    private void expandCard() {
        removeBubbleView();

        cardView = LayoutInflater.from(this).inflate(R.layout.overlay_quickadd, null);
        EditText titleInput = cardView.findViewById(R.id.overlayTitleInput);
        EditText contentInput = cardView.findViewById(R.id.overlayContentInput);
        EditText tagsInput = cardView.findViewById(R.id.overlayTagsInput);
        LinearLayout tagChips = cardView.findViewById(R.id.overlayTagChips);
        TextView statusText = cardView.findViewById(R.id.overlayStatusText);
        TextView cancelButton = cardView.findViewById(R.id.overlayCancelButton);
        TextView saveButton = cardView.findViewById(R.id.overlaySaveButton);
        TextView micButton = cardView.findViewById(R.id.overlayMicButton);

        // マイクボタンが無い時に最後にフォーカスしていた欄へ差し込めるよう、フォーカス監視だけ入れておく。
        View.OnFocusChangeListener trackFocus = (v, hasFocus) -> {
            if (hasFocus) activeInputForSpeech = (EditText) v;
        };
        titleInput.setOnFocusChangeListener(trackFocus);
        contentInput.setOnFocusChangeListener(trackFocus);
        activeInputForSpeech = contentInput;

        cancelButton.setOnClickListener(v -> collapseCard());

        // マイクボタンを押した瞬間の入力欄を確定して渡す。フォーカス監視(trackFocus)頼みだと、
        // マイクボタン自体がタップされた拍子にフォーカスがタイトル欄へ戻ってしまうことがあり、
        // 「本文欄を狙って話したのにタイトルに入る/入らない」という不具合の原因になっていた。
        micButton.setOnClickListener(v -> {
            EditText target = contentInput.hasFocus() ? contentInput
                : titleInput.hasFocus() ? titleInput
                : activeInputForSpeech;
            toggleSpeechInput(statusText, target);
        });

        saveButton.setOnClickListener(v -> {
            String title = titleInput.getText().toString().trim();
            String content = contentInput.getText().toString().trim();
            List<String> tags = parseTags(tagsInput.getText().toString());
            if (title.isEmpty() && content.isEmpty()) {
                collapseCard();
                return;
            }
            statusText.setText("保存中...");
            saveButton.setEnabled(false);
            saveNote(title, content, tags, ok -> {
                saveButton.setEnabled(true);
                if (ok) {
                    statusText.setText("保存しました");
                    cardView.postDelayed(this::collapseCard, 350);
                } else {
                    statusText.setText("保存に失敗しました。もう一度お試しください");
                }
            });
        });

        cardParams = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        // このウィンドウだけは入力を受け付けたいのでFLAG_NOT_FOCUSABLEを付けない。
        // キーボードで隠れないよう、パン方式で調整する。
        cardParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
            | WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE;
        cardParams.gravity = Gravity.TOP | Gravity.START;
        cardParams.x = dpToPx(16);
        cardParams.y = dpToPx(120);

        windowManager.addView(cardView, cardParams);
        cardAdded = true;
        titleInput.requestFocus();
        prefillFromClipboard(contentInput);

        fetchExistingTags(tags -> populateTagChips(tagChips, tagsInput, tags));
    }

    /** 既存タグをタップ候補として並べる。タップで tagsInput にカンマ区切りで追加/解除する。 */
    private void populateTagChips(LinearLayout container, EditText tagsInput, List<String> tags) {
        if (container == null || tags.isEmpty()) return;
        int paddingH = dpToPx(10), paddingV = dpToPx(5), marginEnd = dpToPx(6);
        for (String tag : tags) {
            TextView chip = new TextView(this);
            chip.setText(tag);
            chip.setTextSize(12);
            chip.setPadding(paddingH, paddingV, paddingH, paddingV);
            chip.setBackgroundResource(R.drawable.bg_bubble_circle);
            chip.setTextColor(0xFFFFFFFF);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.setMarginEnd(marginEnd);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                List<String> current = parseTags(tagsInput.getText().toString());
                if (current.contains(tag)) {
                    current.remove(tag);
                } else {
                    current.add(tag);
                }
                tagsInput.setText(String.join(", ", current));
                tagsInput.setSelection(tagsInput.getText().length());
            });
            container.addView(chip);
        }
    }

    private List<String> parseTags(String raw) {
        List<String> tags = new ArrayList<>();
        if (raw == null) return tags;
        for (String part : raw.split("[,、]")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) tags.add(trimmed);
        }
        return tags;
    }

    // ---- 音声入力(マイクボタン) ----

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void toggleSpeechInput(TextView statusText, EditText target) {
        if (!hasMicPermission()) {
            statusText.setText("マイクの許可が必要です（アプリの設定から許可してください）");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            statusText.setText("この端末では音声入力を利用できません");
            return;
        }
        if (speechRecognizer != null) {
            // 二重起動を防ぐため、既に聞き取り中なら一旦止める
            speechRecognizer.destroy();
            speechRecognizer = null;
            statusText.setText("");
            return;
        }
        // このタップで話す内容の差し込み先を確定(以後フォーカスが動いても変わらない)。
        final EditText speechTarget = target;

        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        Intent recognizerIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.JAPAN.toString());
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);

        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { statusText.setText("聞き取り中...話しかけてください"); }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() { statusText.setText("認識中..."); }

            @Override
            public void onError(int error) {
                // 原因特定のため、一旦エラーコードをそのまま表示する(落ち着いたら簡潔なメッセージに戻す)。
                statusText.setText("聞き取れませんでした(" + speechErrorLabel(error) + ")。もう一度お試しください");
                cleanupRecognizer();
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    insertRecognizedText(speechTarget, matches.get(0));
                }
                statusText.setText("");
                cleanupRecognizer();
            }

            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}
        });

        speechRecognizer.startListening(recognizerIntent);
    }

    private void insertRecognizedText(EditText target, String text) {
        if (target == null || text == null || text.isEmpty()) return;
        int start = Math.max(0, target.getSelectionStart());
        CharSequence existing = target.getText();
        String before = existing.subSequence(0, Math.min(start, existing.length())).toString();
        String after = existing.subSequence(Math.min(start, existing.length()), existing.length()).toString();
        target.setText(before + text + after);
        target.setSelection((before + text).length());
    }

    private void cleanupRecognizer() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
    }

    // SpeechRecognizerのエラーコードを人が読める形にする(診断用、2026-09-18追加)。
    private String speechErrorLabel(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "ネットワークタイムアウト";
            case SpeechRecognizer.ERROR_NETWORK: return "ネットワークエラー";
            case SpeechRecognizer.ERROR_AUDIO: return "録音エラー";
            case SpeechRecognizer.ERROR_SERVER: return "サーバーエラー";
            case SpeechRecognizer.ERROR_CLIENT: return "クライアントエラー";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "無音タイムアウト";
            case SpeechRecognizer.ERROR_NO_MATCH: return "認識結果なし";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "認識エンジンがビジー";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "マイク権限不足";
            default: return "コード" + error;
        }
    }

    /**
     * 他アプリ(ブラウザ等)で文章を選択してコピーした状態でこのカードを開くと、
     * 内容欄に自動で転記する。Android 10以降はクリップボード読み取りが
     * 「フォーカスを持つウィンドウ」に限られるため、カードがフォーカスを
     * 得た直後に読む。読めない/空の場合は何もしない。
     */
    private void prefillFromClipboard(EditText contentInput) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) return;
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return;
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            if (text == null || text.length() == 0) return;
            String cleaned = stripKindleStyleCitation(text.toString());
            if (cleaned.isEmpty()) return;
            contentInput.setText(cleaned);
            contentInput.setSelection(contentInput.getText().length());
        } catch (Exception ignored) {
            // クリップボードが読めなくても、空欄のまま続行する
        }
    }

    // Kindle等の読書アプリは、選択範囲をコピーすると自動的に区切り線
    // ("==========")の下に書籍名や位置情報などの引用元情報を付け足すことがある。
    // 「自分で選んだ部分以外は転記しないでほしい」というフィードバックに対応し、
    // 区切り線が見つかったらそれより前(実際に選択した本文)だけを使う。
    private static final Pattern CITATION_DIVIDER = Pattern.compile("(?m)^\\s*=+\\s*$");

    private String stripKindleStyleCitation(String text) {
        Matcher matcher = CITATION_DIVIDER.matcher(text);
        if (matcher.find()) {
            text = text.substring(0, matcher.start());
        }
        return text.trim();
    }

    private void collapseCard() {
        cleanupRecognizer();
        if (cardAdded && cardView != null) {
            try {
                windowManager.removeView(cardView);
            } catch (IllegalArgumentException ignored) {
            }
            cardAdded = false;
            cardView = null;
        }
        if (!bubbleAdded) {
            addBubbleView();
        }
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}
