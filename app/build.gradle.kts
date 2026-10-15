plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// No GitHub Actions cada build ganha um número maior, para instalar por cima da versão antiga.
val numeroBuild = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "io.github.jvhubert.figurinhas"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.jvhubert.figurinhas"
        minSdk = 26
        targetSdk = 35
        versionCode = numeroBuild
        versionName = "1.0.$numeroBuild"

        // Endereço do provedor que o WhatsApp consulta (precisa começar pelo applicationId).
        val autoridade = "io.github.jvhubert.figurinhas.stickercontentprovider"
        manifestPlaceholders["autoridade"] = autoridade
        buildConfigField("String", "AUTORIDADE", "\"$autoridade\"")

        // O yt-dlp traz um Python por arquitetura; só arm64 deixa o APK bem menor.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            // A chave fica fora do repositório; o GitHub Actions recebe pelos secrets.
            System.getenv("CHAVE_ARQUIVO")?.let { arquivo ->
                storeFile = file(arquivo)
                storeType = "pkcs12"
                storePassword = System.getenv("CHAVE_SENHA")
                keyAlias = System.getenv("CHAVE_ALIAS")
                keyPassword = System.getenv("CHAVE_SENHA")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Exigência do youtubedl-android: as bibliotecas nativas precisam ser extraídas.
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
}
