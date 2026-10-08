package com.mipronosticodeportivo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.HttpAuthHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Contenedor WebView de MK Bets.
 * - Solo navega dentro del dominio de la app; cualquier otro enlace se abre en el navegador.
 * - Pide usuario y contraseña (Basic Auth del servidor) y los recuerda en almacenamiento privado.
 * - Muestra una pantalla de error con "Reintentar" si no hay conexión o el servidor está despertando.
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "mi-pronostico-deportivo.onrender.com";
    private static final String APP_URL = "https://" + APP_HOST + "/";
    private static final String PREFS = "mkbets_auth";

    private WebView webView;
    private ProgressBar progress;
    private LinearLayout errorView;
    private int authAttempts = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#06090D"));
        // Android 15 (targetSdk 35) dibuja la app de borde a borde: sin esto el contenido
        // queda debajo de la barra de estado, la muesca y la barra de gestos.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#080B10"));
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(false);
        progress.setMax(100);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4));
        lp.gravity = Gravity.TOP;
        root.addView(progress, lp);

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(APP_URL);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadsImagesAutomatically(true);
        // Endurecimiento: sin acceso a archivos locales ni contenido mixto HTTP.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // Sin aplicación para abrir el enlace
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (errorView.getVisibility() != View.VISIBLE) authAttempts = 0;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                if (!APP_HOST.equals(host)) {
                    handler.cancel();
                    return;
                }
                SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                String user = prefs.getString("user", null);
                String pass = prefs.getString("pass", null);
                authAttempts++;
                if (user != null && pass != null && authAttempts == 1 && handler.useHttpAuthUsernamePassword()) {
                    handler.proceed(user, pass);
                } else {
                    askCredentials(handler, user);
                }
            }
        });
    }

    private void askCredentials(final HttpAuthHandler handler, String lastUser) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);

        final EditText user = new EditText(this);
        user.setHint("Usuario");
        user.setSingleLine(true);
        if (lastUser != null) user.setText(lastUser);
        box.addView(user);

        final EditText pass = new EditText(this);
        pass.setHint("Contraseña");
        pass.setSingleLine(true);
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(pass);

        new AlertDialog.Builder(this)
            .setTitle(authAttempts > 1 ? "Usuario o contraseña incorrectos" : "Iniciar sesión en MK Bets")
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Entrar", (d, w) -> {
                String u = user.getText().toString().trim();
                String p = pass.getText().toString();
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("user", u).putString("pass", p).apply();
                handler.proceed(u, p);
            })
            .setNegativeButton("Cancelar", (d, w) -> {
                handler.cancel();
                showError();
            })
            .show();
    }

    private LinearLayout buildErrorView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        v.setGravity(Gravity.CENTER);
        v.setBackgroundColor(Color.parseColor("#080B10"));
        v.setPadding(dp(32), dp(32), dp(32), dp(32));

        TextView title = new TextView(this);
        title.setText("No se pudo cargar MK Bets");
        title.setTextColor(Color.parseColor("#EEF1F5"));
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        v.addView(title);

        TextView body = new TextView(this);
        body.setText("Revisa tu conexión. Si el servidor estaba inactivo puede tardar hasta un minuto en despertar.");
        body.setTextColor(Color.parseColor("#94A0B2"));
        body.setTextSize(14);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(12), 0, dp(20));
        v.addView(body);

        Button retry = new Button(this);
        retry.setText("Reintentar");
        retry.setOnClickListener(x -> {
            errorView.setVisibility(View.GONE);
            authAttempts = 0;
            webView.reload();
        });
        v.addView(retry);
        return v;
    }

    private void showError() {
        errorView.setVisibility(View.VISIBLE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (errorView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
