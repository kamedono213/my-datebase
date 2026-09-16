package com.kamedono.mydatabase;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.List;

/**
 * ピックノートの「無料10件まで、それ以降は買い切りで解除」を実現するための
 * Play Billing Library v8ラッパー。
 *
 * Play Console側の設定が必須:
 *   アプリの収益化 > 商品 > アプリ内アイテム で、商品ID「pro_unlock」(下のPRODUCT_ID定数と
 *   完全一致させる)の「管理対象アプリ内商品」(消費しない・買い切り)を作成しておくこと。
 *   ここが未作成のうちは queryProductDetailsAsync が空で返ってくる(エラーにはならない)。
 */
@CapacitorPlugin(name = "ProBilling")
public class ProBillingPlugin extends Plugin implements PurchasesUpdatedListener {

    // Play Console側の商品IDと完全一致させること。
    private static final String PRODUCT_ID = "pro_unlock";

    private BillingClient billingClient;
    private ProductDetails cachedProductDetails;
    private PluginCall pendingPurchaseCall;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
            )
            .enableAutoServiceReconnection()
            .build();
    }

    private void ensureConnected(Runnable onReady) {
        if (billingClient.isReady()) {
            onReady.run();
            return;
        }
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult billingResult) {
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    onReady.run();
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // enableAutoServiceReconnection() が有効なので、ここでは何もしない。
            }
        });
    }

    /**
     * 商品の価格・名称を取得する。ボタンに「¥480でアップグレード」のように
     * 実際の価格を表示するために使う。
     */
    @PluginMethod
    public void getProductInfo(PluginCall call) {
        ensureConnected(() -> queryProductDetails(result -> {
            if (result == null) {
                call.reject("product_not_found");
                return;
            }
            ProductDetails.OneTimePurchaseOfferDetails offer = result.getOneTimePurchaseOfferDetails();
            JSObject data = new JSObject();
            data.put("title", result.getName());
            data.put("price", offer != null ? offer.getFormattedPrice() : "");
            call.resolve(data);
        }));
    }

    private interface ProductDetailsCallback {
        void onResult(ProductDetails details);
    }

    private void queryProductDetails(ProductDetailsCallback callback) {
        if (cachedProductDetails != null) {
            callback.onResult(cachedProductDetails);
            return;
        }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                Collections.singletonList(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(PRODUCT_ID)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                )
            )
            .build();

        billingClient.queryProductDetailsAsync(params, (billingResult, queryProductDetailsResult) -> {
            List<ProductDetails> list = queryProductDetailsResult.getProductDetailsList();
            if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK || list.isEmpty()) {
                callback.onResult(null);
                return;
            }
            cachedProductDetails = list.get(0);
            callback.onResult(cachedProductDetails);
        });
    }

    /**
     * 購入フローを起動する。結果はここでは返らず、onPurchasesUpdated()経由で
     * 非同期に返る(Google側の購入画面は別アクティビティで動くため)。
     */
    @PluginMethod
    public void purchase(PluginCall call) {
        call.setKeepAlive(true);
        pendingPurchaseCall = call;
        ensureConnected(() -> queryProductDetails(details -> {
            if (details == null) {
                resolvePendingPurchase(false, "product_not_found");
                return;
            }
            List<ProductDetails.OneTimePurchaseOfferDetails> offers =
                details.getOneTimePurchaseOfferDetails() != null
                    ? Collections.singletonList(details.getOneTimePurchaseOfferDetails())
                    : Collections.emptyList();
            if (offers.isEmpty()) {
                resolvePendingPurchase(false, "no_offer");
                return;
            }

            BillingFlowParams.ProductDetailsParams productDetailsParams =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .build();

            BillingFlowParams billingFlowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(productDetailsParams))
                .build();

            BillingResult launchResult = billingClient.launchBillingFlow(getActivity(), billingFlowParams);
            if (launchResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                resolvePendingPurchase(false, "launch_failed:" + launchResult.getResponseCode());
            }
            // OKの場合はここでは何もしない。ユーザーが購入画面を操作した結果が
            // onPurchasesUpdated()にコールバックされるのを待つ。
        }));
    }

    @Override
    public void onPurchasesUpdated(BillingResult billingResult, List<Purchase> purchases) {
        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            resolvePendingPurchase(false, "canceled");
            return;
        }
        if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK || purchases == null) {
            resolvePendingPurchase(false, "error:" + billingResult.getResponseCode());
            return;
        }
        boolean grantedAny = false;
        for (Purchase purchase : purchases) {
            if (!purchase.getProducts().contains(PRODUCT_ID)) continue;
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                acknowledgeIfNeeded(purchase);
                grantedAny = true;
            }
        }
        resolvePendingPurchase(grantedAny, grantedAny ? "ok" : "not_purchased");
    }

    private void resolvePendingPurchase(boolean granted, String message) {
        if (pendingPurchaseCall == null) return;
        JSObject data = new JSObject();
        data.put("granted", granted);
        data.put("message", message);
        pendingPurchaseCall.resolve(data);
        pendingPurchaseCall.release(getBridge());
        pendingPurchaseCall = null;
    }

    private void acknowledgeIfNeeded(Purchase purchase) {
        if (purchase.isAcknowledged()) return;
        AcknowledgePurchaseParams params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.getPurchaseToken())
            .build();
        billingClient.acknowledgePurchase(params, billingResult -> {
            // 確認結果はログ的な意味合いのみ。失敗してもユーザー体験としては既に購入済み扱いでよく、
            // 3日以内に再試行されれば救済される(Google側が持つ状態のため次回接続時にも再取得できる)。
        });
    }

    /**
     * 再インストールやアプリデータ削除の後でも、実際には購入済みであれば
     * ここで検出してアンロック状態を復元する。アプリ起動時に毎回呼ぶ想定。
     */
    @PluginMethod
    public void restorePurchases(PluginCall call) {
        ensureConnected(() -> {
            QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build();
            billingClient.queryPurchasesAsync(params, (billingResult, purchases) -> {
                boolean owned = false;
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (Purchase purchase : purchases) {
                        if (!purchase.getProducts().contains(PRODUCT_ID)) continue;
                        if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                            acknowledgeIfNeeded(purchase);
                            owned = true;
                        }
                    }
                }
                JSObject data = new JSObject();
                data.put("granted", owned);
                call.resolve(data);
            });
        });
    }
}
