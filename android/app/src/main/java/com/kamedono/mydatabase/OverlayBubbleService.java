package com.kamedono.mydatabase;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;

/**
 * 画面のどこにいても押せる「本アイコン」を常駐表示するフォアグラウンドサービス。
 * ドラッグで移動、タップでQuickAddActivity（クイック追加ダイアログ）を開く。
 */
public class OverlayBubbleService extends Service {

    public static final String CHANNEL_ID = "overlay_bubble_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final int TAP_MOVE_THRESHOLD_PX = 18;

    private WindowManager windowManager;
    private View bubbleView;
    private WindowManager.LayoutParams bubbleParams;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification());
        addBubbleView();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (windowManager != null && bubbleView != null) {
            try {
                windowManager.removeView(bubbleView);
            } catch (IllegalArgumentException ignored) {
                // すでに取り除かれている場合は何もしない
            }
        }
    }

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
            .setContentTitle("知識データベース")
            .setContentText("常駐メモアイコンが有効です")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setOngoing(true)
            .build();
    }

    private void addBubbleView() {
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.ic_bubble_book);
        icon.setBackgroundResource(R.drawable.bg_bubble_circle);
        int paddingPx = dpToPx(14);
        icon.setPadding(paddingPx, paddingPx, paddingPx, paddingPx);
        bubbleView = icon;

        int overlayType = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;

        bubbleParams = new WindowManager.LayoutParams(
            dpToPx(48),
            dpToPx(48),
            overlayType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = 0;
        bubbleParams.y = dpToPx(160);

        windowManager.addView(bubbleView, bubbleParams);

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
                        windowManager.updateViewLayout(bubbleView, bubbleParams);
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            openQuickAdd();
                        }
                        return true;
                }
                return false;
            }
        });
    }

    private void openQuickAdd() {
        Intent intent = new Intent(this, QuickAddActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}
