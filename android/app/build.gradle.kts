plugins {
    id("com.android.application")
}

android {
    namespace = "com.smartsump.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.smartsump.app"
        minSdk = 26          // Android 8.0+
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the local debug key so the APK installs by "sharing"
            // (WhatsApp, Drive...). A Play Store release would use its own key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
