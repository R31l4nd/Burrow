plugins {
    id("com.android.application")
}

// Version from the repo: BURROW_VERSION (make apk passes it), else the
// root package.json, so a build from the source alone (F-Droid) has it too.
// 0.5.0 -> versionCode 500.
val packageVersion = rootProject.file("../package.json").takeIf { it.exists() }?.readText()?.let { Regex(""""version":\s*"(\d+\.\d+\.\d+)"""").find(it)?.groupValues?.get(1) }
val burrowVersion = System.getenv("BURROW_VERSION")?.takeIf { it.matches(Regex("""\d+\.\d+\.\d+""")) } ?: packageVersion ?: "0.0.0"
val burrowVersionCode = burrowVersion.split(".").map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }.coerceAtLeast(1)
// The server the setup screen suggests (BURROW_ORIGIN from .env); editable.
val defaultServer = System.getenv("BURROW_ORIGIN")?.takeIf { it.startsWith("https://") } ?: ""

android {
    namespace = "io.github.r31l4nd.burrow"
    compileSdk = 37
    // The one android/Dockerfile installs (build-tools;36.0.0): AGP would otherwise pick its own default (AUDIT2 AND-22).
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.r31l4nd.burrow"
        minSdk = 29
        targetSdk = 35
        versionCode = burrowVersionCode
        versionName = burrowVersion
        buildConfigField("String", "DEFAULT_SERVER", "\"$defaultServer\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            // The keystore is outside version control. Without it a release
            // build yields an unsigned APK instead of failing, so it is
            // obvious what is missing.
            // Signed only with the key and its password (F-Droid signs its own builds).
            val store = rootProject.file("keystore/burrow.jks")
            if (store.exists() && !System.getenv("KEYSTORE_PASSWORD").isNullOrEmpty()) {
                storeFile = store
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = "burrow"
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
            // v3 (A3-AND-18): with it the key can be rotated later (apksigner
            // rotate, a lineage) and installed apps still take the update. The
            // same key as ever. With minSdk 29 every phone checks v3, so the
            // signer leaves v2 out; installed apps (signed v2) take the update,
            // the certificate being the same. No v4: that is a separate .idsig
            // file for adb's incremental installs, which Burrow does not hand out.
            enableV3Signing = true
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            // Screenshots allowed, so the device test can show every screen.
            buildConfigField("boolean", "SECURE_WINDOWS", "false")
            // The JVM tests' coverage, with a floor (checkUnitTestCoverage below).
            enableUnitTestCoverage = true
            // And the device test's (scripts/android-test.sh pulls it from the
            // emulator; deviceCoverageReport below puts the two together).
            enableAndroidTestCoverage = true
        }
        release {
            buildConfigField("boolean", "SECURE_WINDOWS", "true")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }


    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            // Build metadata of the BouncyCastle jars (sshj), duplicated and unused.
            excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // The JaCoCo the JVM tests' coverage already uses (gradle/verification-metadata.xml), also on the device.
    testCoverage {
        jacocoVersion = "0.8.15"
    }

    // The device test finds Burrow's buttons by their text in the pass's
    // language: web/src/lib/i18n/*.json, copied here by scripts/android-test.sh.
    sourceSets.getByName("androidTest").assets.srcDir("build/test-i18n")

    // Lint fails the build on any warning (A3-AND-12): it ran only in the
    // device test, and its warnings never failed anything. Left out: the
    // KTX style hints and "newer version" notes (versions are pinned on
    // purpose, sshj above all), and the render-process check, which flags
    // every Kotlin WebViewClient (it takes the super constructor call for a
    // plain WebViewClient); WebViewClientsTest checks that rule instead.
    lint {
        warningsAsErrors = true
        abortOnError = true
        disable += setOf("UseKtx", "GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi", "MissingOnRenderProcessGone")
        lintConfig = file("lint.xml")
    }
}

// Debug builds only: the network security config, plus the CA of the device
// test's throwaway TLS proxy when BURROW_TEST_CA points to one
// (scripts/android-test.sh). Release builds never trust anything extra.
abstract class TestNetworkConfig : DefaultTask() {
    @get:Input
    abstract val ca: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun write() {
        val dir = outputDir.get().asFile
        dir.deleteRecursively()
        File(dir, "xml").mkdirs()
        val anchor = if (ca.get().isNotEmpty()) {
            File(dir, "raw").mkdirs()
            File(dir, "raw/test_ca.pem").writeText(ca.get())
            "<certificates src=\"@raw/test_ca\" />"
        } else {
            ""
        }
        File(dir, "xml/network_security_config.xml").writeText(
            """<?xml version="1.0" encoding="utf-8"?>
            |<network-security-config>
            |    <base-config cleartextTrafficPermitted="true">
            |        <trust-anchors>
            |            <certificates src="system" />
            |            $anchor
            |        </trust-anchors>
            |    </base-config>
            |</network-security-config>
            |""".trimMargin(),
        )
    }
}

val testNetworkConfig = tasks.register<TestNetworkConfig>("testNetworkConfig") {
    ca.set(System.getenv("BURROW_TEST_CA")?.takeIf { it.isNotEmpty() }?.let { file(it).readText() } ?: "")
}

androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(testNetworkConfig, TestNetworkConfig::outputDir)
    }
}

// The JVM tests' line coverage of the app's own Kotlin, with a floor
// (A3-AND-13): raise it when tests are added, never lower it. Most of the
// app is Android UI that only the device test reaches; the floor guards
// the pure logic around it.
abstract class CoverageFloor : DefaultTask() {
    @get:InputFile
    abstract val report: RegularFileProperty

    @get:Input
    abstract val floor: Property<Double>

    @TaskAction
    fun check() {
        val xml = report.get().asFile.readText()
        // The report's own totals come last.
        val total = Regex("""<counter type="LINE" missed="(\d+)" covered="(\d+)"/>""").findAll(xml).lastOrNull()
            ?: throw GradleException("no line counts in ${report.get().asFile}")
        val missed = total.groupValues[1].toDouble()
        val covered = total.groupValues[2].toDouble()
        val ratio = covered / (covered + missed)
        logger.lifecycle("JVM test line coverage: %.1f%% (floor %.1f%%)".format(ratio * 100, floor.get() * 100))
        if (ratio < floor.get()) throw GradleException("JVM test line coverage %.1f%% is below its floor %.1f%%".format(ratio * 100, floor.get() * 100))
    }
}

val checkUnitTestCoverage = tasks.register<CoverageFloor>("checkUnitTestCoverage") {
    dependsOn("createDebugUnitTestCoverageReport")
    report.set(layout.buildDirectory.file("reports/coverage/test/debug/report.xml"))
    floor.set(0.28)
}

// What the device test (scripts/android-test.sh) covers, alone and with the
// JVM tests: most of the app is Android UI that only the device test
// reaches. The script pulls each instrumentation run's coverage file into
// build/outputs/device-coverage/; no floor here (the device test is not in
// the gate), the numbers are for a person to read.
// AGP brings Gradle's JaCoCo plugin along, at Gradle's own default version:
// the one the JVM tests' report uses instead (gradle/verification-metadata.xml).
afterEvaluate { extensions.getByType<JacocoPluginExtension>().toolVersion = "0.8.15" }
val appClasses = fileTree(layout.buildDirectory.dir("intermediates/built_in_kotlinc/debug/compileDebugKotlin/classes")) {
    // Generated, not the app's own code.
    exclude("**/R.class", "**/R$*.class", "**/BuildConfig.class")
}
val deviceExec = fileTree(layout.buildDirectory.dir("outputs/device-coverage")) { include("*.ec") }
val unitExec = fileTree(layout.buildDirectory.dir("outputs/unit_test_code_coverage/debugUnitTest")) { include("*.exec") }
tasks.register<JacocoReport>("deviceCoverageReport") {
    description = "Line coverage of the device test alone."
    executionData.from(deviceExec)
    classDirectories.from(appClasses)
    sourceDirectories.from("src/main/kotlin")
    reports {
        xml.required = true
        html.required = false
        xml.outputLocation = layout.buildDirectory.file("reports/coverage/device/report.xml")
    }
}
tasks.register<JacocoReport>("combinedCoverageReport") {
    description = "Line coverage of the device and JVM tests together."
    executionData.from(deviceExec, unitExec)
    classDirectories.from(appClasses)
    sourceDirectories.from("src/main/kotlin")
    reports {
        xml.required = true
        html.required = true
        xml.outputLocation = layout.buildDirectory.file("reports/coverage/combined/report.xml")
        html.outputLocation = layout.buildDirectory.dir("reports/coverage/combined/html")
    }
}

// The totals of both, for the script's output (the HTML report has each file).
abstract class CoverageTotals : DefaultTask() {
    @get:InputFiles
    abstract val reports: ConfigurableFileCollection

    @TaskAction
    fun show() {
        for (f in reports.files) {
            if (!f.exists()) continue
            val total = Regex("""<counter type="LINE" missed="(\d+)" covered="(\d+)"/>""").findAll(f.readText()).lastOrNull() ?: continue
            val missed = total.groupValues[1].toDouble()
            val covered = total.groupValues[2].toDouble()
            logger.quiet("%s line coverage: %.1f%% (%d of %d lines)".format(f.parentFile.name, covered * 100 / (covered + missed), covered.toLong(), (covered + missed).toLong()))
        }
    }
}
tasks.register<CoverageTotals>("showDeviceCoverage") {
    mustRunAfter("deviceCoverageReport", "combinedCoverageReport")
    reports.from(layout.buildDirectory.file("reports/coverage/device/report.xml"), layout.buildDirectory.file("reports/coverage/combined/report.xml"))
}

// Tests always run for the build that ships, never inherit an earlier result
// from the up-to-date check or the build cache.
tasks.withType<Test>().configureEach {
    outputs.upToDateWhen { false }
    outputs.cacheIf { false }
}

// The app's own WireGuard (../wg, Go): bound with gomobile into an AAR,
// rebuilt when its Go files change. -trimpath and an empty build id keep the
// library the same for the same source (reproducible, for F-Droid).
val wgDir = rootProject.file("wg")
val wgAar = layout.buildDirectory.file("wg/wgtunnel.aar")
val buildWgTunnel = tasks.register<Exec>("buildWgTunnel") {
    inputs.dir(wgDir)
    outputs.file(wgAar)
    workingDir = wgDir
    commandLine(
        "gomobile", "bind",
        "-target=android/arm64,android/arm,android/amd64",
        "-androidapi", "29",
        "-javapkg", "io.github.r31l4nd.burrow.wg",
        "-trimpath", "-ldflags=-s -w -buildid=",
        "-o", wgAar.get().asFile.path,
        ".",
    )
}
tasks.named("preBuild") { dependsOn(buildWgTunnel) }

dependencies {
    // The WireGuard tunnel (see above).
    implementation(files(wgAar).builtBy(buildWgTunnel))
    // Deliberately small: no Play Services, no UI toolkit beyond AppCompat.
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.appcompat:appcompat:1.8.0")
    // WebMessageListener (the bridge, only for the server's origin) and
    // profiles (each app tab its own cookies).
    implementation("androidx.webkit:webkit:1.17.1")
    // Burrow's own push without Google: a UnifiedPush distributor (the ntfy app) carries it.
    implementation("org.unifiedpush.android:connector:3.3.5")
    // A WireGuard QR code read with the camera (#96): ZXing, no Google
    // services, as WireGuard's own app. Its core at the newest release.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0") { isTransitive = false }
    implementation("com.google.zxing:core:3.5.3")
    // The fingerprint prompt, also to unlock the device key.
    implementation("androidx.biometric:biometric:1.1.0")
    // The direct SSH route (phase 5): the app's own SSH client, used only
    // when Burrow cannot be reached.
    // Stays at 0.39: from 0.40 sshj does curve25519/ed25519 through
    // BouncyCastle, which Android's own "BC" provider gets in the way of (the
    // direct route stopped connecting: DirectRouteTest d2/d3).
    implementation("com.hierynomus:sshj:0.39.0")
    // sshj 0.39 brings BouncyCastle 1.78.1, with advisories fixed by 1.85
    // (GOST keystream reuse, name constraints, ASN.1 depth, PKIX allocation):
    // the newest, with the same API. Checked by DirectRouteTest d2/d3.
    constraints {
        implementation("org.bouncycastle:bcprov-jdk18on:1.85")
        implementation("org.bouncycastle:bcpkix-jdk18on:1.85")
        implementation("org.bouncycastle:bcutil-jdk18on:1.85")
    }

    testImplementation("junit:junit:4.13.2")
    // Android has only a stub org.json in JVM tests.
    testImplementation("org.json:json:20260814")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    // Stubs the "open with" app chooser in the device test.
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.7.0")
    // Taps system and WebView dialogs (confirm()) in the device test.
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0")
}
