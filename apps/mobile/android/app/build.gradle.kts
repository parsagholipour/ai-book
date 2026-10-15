import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Messaging and crash reporting share the Firebase project config. Builds
// without it still work, with both services off; see docs/crash-reporting.md.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
    apply(plugin = "com.google.firebase.crashlytics")
}

// The upload key Google Play receives. `android/key.properties` (gitignored, with
// the keystore it names) holds storeFile, storePassword, keyAlias and
// keyPassword; apps/mobile/CLAUDE.md, "Release signing", says how to make both.
//
// A release APK or bundle without it fails before anything compiles. It used to
// fall back to the debug key in silence, and the only bundle ever built
// (2026-10-03) was debug-signed, which Play refuses. A local
// `flutter run --release` on a machine with no upload key opts in explicitly:
// `-P allowDebugSigning=true` (flutter passes `-P` through to Gradle), or
// ORG_GRADLE_PROJECT_allowDebugSigning=true in the environment.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) keystorePropertiesFile.inputStream().use { load(it) }
}
val missingUploadKeyFields = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    .filter { keystoreProperties.getProperty(it).isNullOrBlank() }
val hasUploadKey = keystorePropertiesFile.exists() && missingUploadKeyFields.isEmpty()
val allowDebugSigning = findProperty("allowDebugSigning")?.toString()?.toBoolean() == true

// Every task that writes a signed release artifact, flavored or not:
// assembleRelease/packageRelease (APK), bundleRelease/signReleaseBundle (AAB),
// installRelease. Debug tasks and release *inputs* (packageReleaseResources…)
// do not match.
val signedReleaseTask = Regex("^(assemble|bundle|package|sign|install)\\w*Release(Bundle)?$")
val appProject = project
gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.project == appProject && signedReleaseTask.matches(it.name) }
    if (buildsRelease && !hasUploadKey && !allowDebugSigning) {
        val problem = if (keystorePropertiesFile.exists()) {
            "android/key.properties is missing ${missingUploadKeyFields.joinToString(", ")}"
        } else {
            "android/key.properties does not exist"
        }
        throw GradleException(
            "Refusing to build a release without the upload key: $problem. " +
                "Google Play rejects a debug-signed bundle. Create the upload keystore and " +
                "key.properties (apps/mobile/CLAUDE.md, \"Release signing\"). For a local " +
                "`flutter run --release` only, pass -P allowDebugSigning=true."
        )
    }
}

android {
    namespace = "com.tomeza.tomeza"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // flutter_local_notifications uses java.time, which needs desugaring
        // below API 26.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.tomeza.tomeza"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["crashlyticsCollectionEnabled"] = "false"
    }

    signingConfigs {
        if (hasUploadKey) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Without the upload key and without the opt-in the task-graph check
            // above has already failed the build; null here means a release
            // task it somehow missed produces an unsigned artifact, never a
            // debug-signed one.
            signingConfig = when {
                hasUploadKey -> signingConfigs.getByName("release")
                allowDebugSigning -> signingConfigs.getByName("debug")
                else -> null
            }
            manifestPlaceholders["crashlyticsCollectionEnabled"] = "true"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // Play Install Referrer (~20 KB, no transitive dependencies): read once per
    // install by InstallReferrer.kt, so an install from a shared book's page is
    // attributed and offered that book's remix.
    implementation("com.android.installreferrer:installreferrer:2.2")
}
