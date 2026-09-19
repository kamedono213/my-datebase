package com.kamedono.mydatabase;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OverlayPlugin.class);
        registerPlugin(ProBillingPlugin.class);
        registerPlugin(BackupExportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
