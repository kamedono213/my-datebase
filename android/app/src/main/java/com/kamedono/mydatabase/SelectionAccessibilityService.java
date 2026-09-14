package com.kamedono.mydatabase;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * 本アイコンを押した瞬間、今まさに画面で選択されている文字列だけを直接読み取るための
 * アクセシビリティサービス。クリップボードは「明示的にコピーした時」しか更新されず、
 * 選択しただけではクリップボードに反映されない(=以前コピーした古い内容が転記されてしまう)
 * 問題を避けるために導入。継続的な監視は行わず、OverlayBubbleServiceから
 * 呼ばれた時にその場で選択範囲を探すだけ。
 */
public class SelectionAccessibilityService extends AccessibilityService {

    private static SelectionAccessibilityService instance;

    static SelectionAccessibilityService getInstance() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // イベントを継続的に処理する必要はない。getCurrentSelectionText()から
        // 呼ばれた時にその場でウィンドウの木を探索するだけで十分。
    }

    @Override
    public void onInterrupt() {
        // 何もしない
    }

    /**
     * 現在アクティブなウィンドウの中から、テキスト選択範囲を持つノードを探して返す。
     * 見つからなければnull。
     */
    String getCurrentSelectionText() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        try {
            return findSelectedText(root, 0);
        } finally {
            root.recycle();
        }
    }

    private String findSelectedText(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 40) return null;

        int start = node.getTextSelectionStart();
        int end = node.getTextSelectionEnd();
        CharSequence text = node.getText();
        if (start >= 0 && end >= 0 && start != end && text != null) {
            int from = Math.min(start, end);
            int to = Math.max(start, end);
            if (to <= text.length()) {
                String selected = text.subSequence(from, to).toString().trim();
                if (!selected.isEmpty()) return selected;
            }
        }

        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                String found = findSelectedText(child, depth + 1);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return null;
    }
}
