package com.mipronosticodeportivo;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent intent = new Intent(
            Intent.ACTION_VIEW,
            Uri.parse("https://mi-pronostico-deportivo.onrender.com/")
        );

        startActivity(intent);
        finish();
    }
}
