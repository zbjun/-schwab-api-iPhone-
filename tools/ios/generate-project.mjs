import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ios = path.join(root, 'ios');
const check = process.argv.includes('--check');
const id = (name) => createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase();
const quote = (value) => JSON.stringify(value);
const list = (values) => `(${values.join(', ')})`;
async function swiftFiles(directory) {
  const result = [];
  for (const item of await readdir(path.join(ios, directory), { withFileTypes: true })) {
    const relative = `${directory}/${item.name}`;
    if (item.isDirectory()) result.push(...await swiftFiles(relative));
    else if (item.name.endsWith('.swift')) result.push(relative);
  }
  return result.sort();
}

const appFiles = await swiftFiles('THS');
const testFiles = await swiftFiles('THSTests');
const uiTestFiles = await swiftFiles('THSUITests');
if (!appFiles.length || !testFiles.length) throw new Error('App and test Swift sources must exist before project generation.');
const objects = [];
const add = (name, body) => { objects.push(`\t\t${id(name)} = { ${body} };`); return id(name); };
for (const file of [...appFiles, ...testFiles, ...uiTestFiles]) {
  add(`ref:${file}`, `isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${quote(file)}; sourceTree = SOURCE_ROOT;`);
  add(`build:${file}`, `isa = PBXBuildFile; fileRef = ${id(`ref:${file}`)};`);
}
add('ref:plist', 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = THS/Info.plist; sourceTree = SOURCE_ROOT;');
add('product:app', 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = THS.app; sourceTree = BUILT_PRODUCTS_DIR;');
add('product:tests', 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = THSTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;');
add('product:uitests', 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = THSUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;');
add('group:app', `isa = PBXGroup; children = ${list([...appFiles.map(f => id(`ref:${f}`)), id('ref:plist')])}; name = THS; sourceTree = "<group>";`);
add('group:tests', `isa = PBXGroup; children = ${list(testFiles.map(f => id(`ref:${f}`)))}; name = THSTests; sourceTree = "<group>";`);
add('group:uitests', `isa = PBXGroup; children = ${list(uiTestFiles.map(f => id(`ref:${f}`)))}; name = THSUITests; sourceTree = "<group>";`);
add('group:products', `isa = PBXGroup; children = ${list([id('product:app'), id('product:tests'), id('product:uitests')])}; name = Products; sourceTree = "<group>";`);
add('group:root', `isa = PBXGroup; children = ${list([id('group:app'), id('group:tests'), id('group:uitests'), id('group:products')])}; sourceTree = "<group>";`);
for (const [target, files] of [['app', appFiles], ['tests', testFiles], ['uitests', uiTestFiles]]) {
  add(`sources:${target}`, `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ${list(files.map(f => id(`build:${f}`)))}; runOnlyForDeploymentPostprocessing = 0;`);
  for (const phase of ['frameworks', 'resources']) {
    add(`${phase}:${target}`, `isa = ${phase === 'frameworks' ? 'PBXFrameworksBuildPhase' : 'PBXResourcesBuildPhase'}; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;`);
  }
}
add('proxy:app', `isa = PBXContainerItemProxy; containerPortal = ${id('project')}; proxyType = 1; remoteGlobalIDString = ${id('target:app')}; remoteInfo = THS;`);
add('dependency:app', `isa = PBXTargetDependency; target = ${id('target:app')}; targetProxy = ${id('proxy:app')};`);
add('target:app', `isa = PBXNativeTarget; buildConfigurationList = ${id('configs:app')}; buildPhases = ${list(['sources:app','frameworks:app','resources:app'].map(id))}; buildRules = (); dependencies = (); name = THS; productName = THS; productReference = ${id('product:app')}; productType = "com.apple.product-type.application";`);
add('target:tests', `isa = PBXNativeTarget; buildConfigurationList = ${id('configs:tests')}; buildPhases = ${list(['sources:tests','frameworks:tests','resources:tests'].map(id))}; buildRules = (); dependencies = (${id('dependency:app')}); name = THSTests; productName = THSTests; productReference = ${id('product:tests')}; productType = "com.apple.product-type.bundle.unit-test";`);
add('target:uitests', `isa = PBXNativeTarget; buildConfigurationList = ${id('configs:uitests')}; buildPhases = ${list(['sources:uitests','frameworks:uitests','resources:uitests'].map(id))}; buildRules = (); dependencies = (${id('dependency:app')}); name = THSUITests; productName = THSUITests; productReference = ${id('product:uitests')}; productType = "com.apple.product-type.bundle.ui-testing";`);
const common = 'CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos; SWIFT_VERSION = 5.0; SWIFT_STRICT_CONCURRENCY = targeted;';
for (const name of ['Debug', 'Release']) {
  add(`config:project:${name}`, `isa = XCBuildConfiguration; buildSettings = { ${common} ${name === 'Debug' ? 'DEBUG_INFORMATION_FORMAT = dwarf; ENABLE_TESTABILITY = YES; GCC_PREPROCESSOR_DEFINITIONS = ("DEBUG=1", "$(inherited)"); ONLY_ACTIVE_ARCH = YES; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone";' : 'DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_OPTIMIZATION_LEVEL = "-O"; VALIDATE_PRODUCT = YES;'} }; name = ${name};`);
  add(`config:app:${name}`, `isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 3; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = THS/Info.plist; LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks"); MARKETING_VERSION = 0.3.0; PRODUCT_BUNDLE_IDENTIFIER = app.personal.ths; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; TARGETED_DEVICE_FAMILY = 1; }; name = ${name};`);
  add(`config:tests:${name}`, `isa = XCBuildConfiguration; buildSettings = { BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = app.personal.ths.tests; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; TARGETED_DEVICE_FAMILY = 1; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/THS.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/THS"; }; name = ${name};`);
  add(`config:uitests:${name}`, `isa = XCBuildConfiguration; buildSettings = { CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = app.personal.ths.uitests; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; TARGETED_DEVICE_FAMILY = 1; TEST_TARGET_NAME = THS; }; name = ${name};`);
}
for (const target of ['project','app','tests','uitests']) {
  add(`configs:${target}`, `isa = XCConfigurationList; buildConfigurations = ${list(['Debug','Release'].map(name => id(`config:${target}:${name}`)))}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;`);
}
add('project', `isa = PBXProject; attributes = { BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2600; TargetAttributes = { ${id('target:app')} = { CreatedOnToolsVersion = 26.0; }; ${id('target:tests')} = { CreatedOnToolsVersion = 26.0; TestTargetID = ${id('target:app')}; }; ${id('target:uitests')} = { CreatedOnToolsVersion = 26.0; TestTargetID = ${id('target:app')}; }; }; }; buildConfigurationList = ${id('configs:project')}; compatibilityVersion = "Xcode 14.0"; developmentRegion = zh_CN; hasScannedForEncodings = 0; knownRegions = (en, Base, zh_CN); mainGroup = ${id('group:root')}; productRefGroup = ${id('group:products')}; projectDirPath = ""; projectRoot = ""; targets = ${list([id('target:app'),id('target:tests'),id('target:uitests')])};`);
const project = `// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n${objects.join('\n')}\n\t};\n\trootObject = ${id('project')};\n}\n`;
const ref = (target, name) => `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id(`target:${target}`)}" BuildableName="${name}" BlueprintName="${{app:'THS',tests:'THSTests',uitests:'THSUITests'}[target]}" ReferencedContainer="container:THS.xcodeproj"/>`;
const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${ref('app','THS.app')}</BuildActionEntry>
    <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">${ref('tests','THSTests.xctest')}</BuildActionEntry>
    <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">${ref('uitests','THSUITests.xctest')}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables><TestableReference skipped="NO" parallelizable="NO">${ref('tests','THSTests.xctest')}</TestableReference><TestableReference skipped="NO" parallelizable="NO">${ref('uitests','THSUITests.xctest')}</TestableReference></Testables>
    <MacroExpansion>${ref('app','THS.app')}</MacroExpansion>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${ref('app','THS.app')}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${ref('app','THS.app')}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
for (const [relative, content] of [['THS.xcodeproj/project.pbxproj', project], ['THS.xcodeproj/xcshareddata/xcschemes/THS.xcscheme', scheme]]) {
  const destination = path.join(ios, relative);
  if (check) {
    if (await readFile(destination, 'utf8') !== content) throw new Error(`Regenerate ${relative} with node tools/ios/generate-project.mjs`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} Xcode project: ${appFiles.length} app sources, ${testFiles.length} unit test sources, ${uiTestFiles.length} UI test sources.`);
