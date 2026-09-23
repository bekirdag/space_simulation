#!/usr/bin/env ruby
# Regenerates ios/CosmosMap.xcodeproj. The generated project is committed; rerun this
# after adding/removing Swift files or changing build settings:
#   ruby ios/scripts/generate_xcode_project.rb
# Requires the `xcodeproj` gem (tested with 1.24).

require "xcodeproj"

ROOT = File.expand_path("..", __dir__) # ios/
PROJECT_PATH = File.join(ROOT, "CosmosMap.xcodeproj")
APP_NAME = "CosmosMap"
APP_BUNDLE_IDENTIFIER = "com.wodo.cosmosmap"
APPLE_TEAM_ID = "AH277897AV"
APP_STORE_PROFILE = "CosmosMap App Store"
# Override only for local runs on older Xcode/simulators (do not commit a project generated that way).
DEPLOYMENT_TARGET = ENV.fetch("COSMOSMAP_DEPLOYMENT_TARGET", "26.0")
# Firebase Apple SDK (Swift Package Manager). 12.14.0 is the newest release whose Package.swift
# still uses swift-tools-version 6.0, so it resolves with Xcode 16.2 as well as Xcode 26
# (12.15.0+ need swift-tools 6.1 / Xcode 16.3+). The resolved revisions are pinned in
# CosmosMap.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved (committed).
FIREBASE_REPOSITORY_URL = "https://github.com/firebase/firebase-ios-sdk"
FIREBASE_VERSION = "12.14.0"
# FirebaseAnalyticsCore = Analytics without GoogleAppMeasurementIdentitySupport (no IDFA /
# AdSupport) and without the Google Ads on-device-conversion SDK that FirebaseAnalytics pulls in.
FIREBASE_PRODUCTS = %w[FirebaseCrashlytics FirebaseAnalyticsCore].freeze

project = Xcodeproj::Project.new(PROJECT_PATH)
project.root_object.attributes["LastSwiftUpdateCheck"] = "1620"
project.root_object.attributes["LastUpgradeCheck"] = "1620"

app_target = project.new_target(:application, APP_NAME, :ios, DEPLOYMENT_TARGET)
test_target = project.new_target(:unit_test_bundle, "#{APP_NAME}Tests", :ios, DEPLOYMENT_TARGET)
test_target.add_dependency(app_target)

# --- App sources & resources -------------------------------------------------------------
app_group = project.main_group.new_group(APP_NAME, APP_NAME)
Dir.glob(File.join(ROOT, APP_NAME, "**", "*.swift")).sort.each do |path|
  relative = path.delete_prefix(File.join(ROOT, APP_NAME) + "/")
  next if relative.start_with?("Web/")

  reference = app_group.new_file(relative)
  app_target.source_build_phase.add_file_reference(reference)
end

app_group.new_file("Resources/Info.plist")
privacy_manifest = app_group.new_file("Resources/PrivacyInfo.xcprivacy")
app_target.resources_build_phase.add_file_reference(privacy_manifest)
asset_catalog = app_group.new_file("Assets.xcassets")
app_target.resources_build_phase.add_file_reference(asset_catalog)

# The web build (synced from dist/ by ios/scripts/sync-web.sh, gitignored) is a folder
# reference, so the directory tree is copied verbatim to CosmosMap.app/Web/.
web_folder = app_group.new_file("Web")
web_folder.last_known_file_type = "folder"
app_target.resources_build_phase.add_file_reference(web_folder)

# Fail early (instead of shipping an empty shell) when the web build was not synced.
check_phase = app_target.new_shell_script_build_phase("Check bundled web build")
check_phase.shell_script = <<~SH
  if [ ! -f "${SRCROOT}/CosmosMap/Web/index.html" ]; then
    echo "error: ios/CosmosMap/Web/index.html is missing. Run 'npm run build && ios/scripts/sync-web.sh' from the repo root."
    exit 1
  fi
SH
check_phase.input_paths = ["$(SRCROOT)/CosmosMap/Web/index.html"]
check_phase.output_paths = []
check_phase.always_out_of_date = "1"
# Run before resources are copied.
app_target.build_phases.move(check_phase, 0)

# Firebase config (GoogleService-Info.plist) is kept out of the public repo (gitignored);
# CI writes it from the COSMOSMAP_GOOGLE_SERVICE_INFO secret. It is copied by a script
# instead of being a file reference so builds without it still work. Release builds must
# have it, so a CI/App Store build can't silently ship without crash reporting.
google_service_phase = app_target.new_shell_script_build_phase("Copy GoogleService-Info.plist")
google_service_phase.shell_script = <<~SH
  SOURCE="${SRCROOT}/CosmosMap/Resources/GoogleService-Info.plist"
  DESTINATION="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist"
  if [ -f "$SOURCE" ]; then
    cp -f "$SOURCE" "$DESTINATION"
    echo "Copied GoogleService-Info.plist into the app bundle."
  elif [ "$CONFIGURATION" = "Release" ]; then
    echo "error: ios/CosmosMap/Resources/GoogleService-Info.plist is missing. Release builds need it (CI decodes the COSMOSMAP_GOOGLE_SERVICE_INFO secret into that path)."
    exit 1
  else
    rm -f "$DESTINATION"
    echo "note: GoogleService-Info.plist not found; Firebase stays disabled in this build."
  fi
SH
google_service_phase.input_paths = []
google_service_phase.output_paths = []
google_service_phase.always_out_of_date = "1"

# Crashlytics dSYM upload (must be the last phase). Only for Release builds/archives that
# have the Firebase config; everything else skips it.
crashlytics_phase = app_target.new_shell_script_build_phase("Upload Crashlytics symbols")
crashlytics_phase.shell_script = <<~SH
  if [ "$CONFIGURATION" != "Release" ]; then
    echo "Skipping Crashlytics symbol upload for $CONFIGURATION."
    exit 0
  fi
  if [ ! -f "${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist" ]; then
    echo "warning: Skipping Crashlytics symbol upload: GoogleService-Info.plist is not in the app bundle."
    exit 0
  fi
  CRASHLYTICS_RUN="${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run"
  if [ ! -x "$CRASHLYTICS_RUN" ]; then
    echo "warning: Skipping Crashlytics symbol upload: $CRASHLYTICS_RUN not found."
    exit 0
  fi
  "$CRASHLYTICS_RUN"
SH
crashlytics_phase.input_paths = [
  "${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}",
  "${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${PRODUCT_NAME}",
  "${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Info.plist",
  "$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/GoogleService-Info.plist",
  "$(TARGET_BUILD_DIR)/$(EXECUTABLE_PATH)",
]
crashlytics_phase.output_paths = []
crashlytics_phase.always_out_of_date = "1"

# --- Swift packages ----------------------------------------------------------------------
firebase_package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
firebase_package.repositoryURL = FIREBASE_REPOSITORY_URL
firebase_package.requirement = { "kind" => "exactVersion", "version" => FIREBASE_VERSION }
project.root_object.package_references << firebase_package

FIREBASE_PRODUCTS.each do |product_name|
  dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dependency.package = firebase_package
  dependency.product_name = product_name
  app_target.package_product_dependencies << dependency

  build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build_file.product_ref = dependency
  app_target.frameworks_build_phase.files << build_file
end

# --- Tests -----------------------------------------------------------------------------
tests_group = project.main_group.new_group("#{APP_NAME}Tests", "#{APP_NAME}Tests")
Dir.glob(File.join(ROOT, "#{APP_NAME}Tests", "*.swift")).sort.each do |path|
  reference = tests_group.new_file(File.basename(path))
  test_target.source_build_phase.add_file_reference(reference)
end

# --- Build settings ----------------------------------------------------------------------
app_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = APP_BUNDLE_IDENTIFIER
  settings["PRODUCT_NAME"] = "$(TARGET_NAME)"
  settings["INFOPLIST_FILE"] = "CosmosMap/Resources/Info.plist"
  settings["GENERATE_INFOPLIST_FILE"] = "NO"
  settings["MARKETING_VERSION"] = "1.0"
  settings["CURRENT_PROJECT_VERSION"] = "1" # CI overrides this per upload.
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT_TARGET
  settings["ASSETCATALOG_COMPILER_APPICON_NAME"] = "AppIcon"
  settings["ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS"] = "NO"
  settings["ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME"] = ""
  settings["SWIFT_VERSION"] = "5.0"
  settings["SWIFT_STRICT_CONCURRENCY"] = "minimal"
  settings["SWIFT_EMIT_LOC_STRINGS"] = "NO"
  settings["TARGETED_DEVICE_FAMILY"] = "2"
  settings["SUPPORTS_MACCATALYST"] = "NO"
  settings["SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD"] = "NO"
  settings["SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD"] = "NO"
  settings["ENABLE_PREVIEWS"] = "NO"
  # NO: the Crashlytics upload script reads the SPM checkout and the dSYM, and the config
  # copy script writes into the app bundle; neither fits the user-script sandbox.
  settings["ENABLE_USER_SCRIPT_SANDBOXING"] = "NO"
  # Crashlytics needs dSYMs to symbolicate (Debug too, so a Debug crash is readable).
  settings["DEBUG_INFORMATION_FORMAT"] = "dwarf-with-dsym"
  settings["DEAD_CODE_STRIPPING"] = "YES"
  settings["DEVELOPMENT_TEAM"] = APPLE_TEAM_ID
  settings["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks"]
  if configuration.name == "Debug"
    settings["CODE_SIGN_STYLE"] = "Automatic"
    settings["CODE_SIGN_IDENTITY"] = "Apple Development"
  else
    settings["CODE_SIGN_STYLE"] = "Manual"
    settings["CODE_SIGN_IDENTITY"] = "Apple Distribution"
    settings["PROVISIONING_PROFILE_SPECIFIER"] = APP_STORE_PROFILE
  end
end

test_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "#{APP_BUNDLE_IDENTIFIER}.tests"
  settings["GENERATE_INFOPLIST_FILE"] = "YES"
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT_TARGET
  settings["SWIFT_VERSION"] = "5.0"
  settings["SWIFT_STRICT_CONCURRENCY"] = "minimal"
  settings["TARGETED_DEVICE_FAMILY"] = "2"
  settings["TEST_HOST"] = "$(BUILT_PRODUCTS_DIR)/#{APP_NAME}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/#{APP_NAME}"
  settings["BUNDLE_LOADER"] = "$(TEST_HOST)"
  settings["DEVELOPMENT_TEAM"] = APPLE_TEAM_ID
  settings["CODE_SIGN_STYLE"] = "Automatic"
end

# The first pass stabilizes target IDs; the second stabilizes dependency-proxy paths that
# contain those IDs.
project.predictabilize_uuids
project.predictabilize_uuids

# --- Scheme ------------------------------------------------------------------------------
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app_target)
scheme.add_build_target(test_target)
test_build_entry = scheme.build_action.entries.last
test_build_entry.build_for_running = false
test_build_entry.build_for_profiling = false
test_build_entry.build_for_archiving = false
test_build_entry.build_for_analyzing = false
scheme.add_test_target(test_target)
scheme.set_launch_target(app_target)
scheme.save_as(PROJECT_PATH, APP_NAME, true)

project.save
puts "Generated #{PROJECT_PATH}"
