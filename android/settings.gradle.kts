// Smart Sump phone app: a thin Android shell around the dashboard, with the
// virtual sump built in. The web part is built by `npm run build:apk` in
// dashboard/, which writes app/src/main/assets/index.html.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SmartSump"
include(":app")
