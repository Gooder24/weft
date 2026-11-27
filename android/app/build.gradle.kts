plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sk.karchi.weft.phone"
    compileSdk = 35
    defaultConfig {
        applicationId = "sk.karchi.weft.phone"
        minSdk = 26 // Tailscale's own minimum: the phone reaches Weft only through it
        targetSdk = 35
        versionCode = 2
        versionName = "0.2"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the build machine's own debug key, so a new build installs over the old one.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
