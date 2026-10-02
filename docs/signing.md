# Code signing (Windows) · توقيع البرنامج

**Why.** Windows 11 *Smart App Control* and SmartScreen block unsigned programs: `Rico.exe`, the NSIS installer, `llama-server.exe`, the `ggml-*.dll` / `llama*.dll` backends and node-llama-cpp's `.node` files. A signature is the only real fix (the user must not be asked to turn security features off).

**Free path: SignPath Foundation** – free code signing for open-source projects (certificate issued to SignPath Foundation, so no personal certificate or fee). Requirements: an OSI-approved license at the repo root (`LICENSE` = MIT ✔; `app/package.json` `license` must match: `"MIT"`), public repo, binaries **built in CI** from the public source (so signed files are provably ours – that is why `build-app.yml` can build `llama-server` from source), a README/privacy statement (Rico: no network, no telemetry ✔).

## One-time setup
1. Apply at <https://signpath.org/foundation/> (project: `giumaa/rico-ai`, license MIT, public repo, link to `docs/signing.md`). Approval takes days; until then keep the job disabled.
2. In SignPath create **Project** `rico` with two **artifact configurations** (slugs below) and a **signing policy** (e.g. `release-signing`, origin = this GitHub repo, requires the CI trusted build system):

   `win-unpacked-app` (zip of `win-unpacked/`, sign every PE file that is ours – including the unpacked native modules):
   ```xml
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <zip-file>
       <directory path="win-unpacked">
         <for-each>
           <file-set>
             <include path="*.exe"/><include path="*.dll"/>
             <include path="resources/**/*.exe"/><include path="resources/**/*.dll"/><include path="resources/**/*.node"/>
             <include path="resources/app.asar.unpacked/**/*.node"/><include path="resources/app.asar.unpacked/**/*.dll"/>
           </file-set>
           <authenticode-sign/>
         </for-each>
       </directory>
     </zip-file>
   </artifact-configuration>
   ```
   `win-installer` (zip containing `Rico-Setup-*.exe`): `<zip-file><file path="Rico-Setup-*.exe"><authenticode-sign/></file></zip-file>`.
   (Third-party DLLs that already carry a valid signature, e.g. Electron's own files, can be left out of the sign list; signing them again is not needed.)
3. Create an API token for the CI user and add to GitHub **Settings → Secrets and variables → Actions**:
   * secret `SIGNPATH_API_TOKEN`
   * variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` (`rico`), `SIGNPATH_SIGNING_POLICY_SLUG`
   * variable **`SIGNPATH_ENABLED` = `true`** ← the switch. While it is not `true` nothing in the workflow touches SignPath.

## What the workflow does when enabled (`.github/workflows/build-app.yml`)
1. `llama-source` builds `llama-server` from source at the pinned llama.cpp tag (repo-root file `LLAMA_CPP_TAG`, shared with `app/scripts/fetch-llama-server.mjs` and all workflows) – Windows/Linux: Vulkan + all CPU variants as loadable backends, macOS arm64: Metal, macOS x64: CPU – into `resources/bin/<os>-<arch>/<variant>/` (the same layout the app expects). It also runs automatically on manual dispatch with *llama_from_source = true*.
2. `windows-signed`: `electron-builder --dir` → zip `win-unpacked` → SignPath signs all exe/dll/node → `electron-builder --prepackaged` builds the NSIS installer from the **signed** files → SignPath signs the installer → artifact `installer-windows-x64-signed`.
3. `release` publishes the signed installer instead of the unsigned `installer-windows-x64` for tags `v*`.

## Other platforms
* **macOS**: real distribution needs an Apple Developer ID ($99/year) + notarization; there is no free equivalent. Current builds are ad-hoc signed (`mac.identity` in `electron-builder.yml`), so Gatekeeper says the app "is damaged / cannot be verified". Users: drag Rico to Applications, then run once
  `xattr -dr com.apple.quarantine /Applications/Rico.app` (or right-click -> Open). Nothing else is needed; Rico makes no network requests besides model downloads you start yourself.
* **Linux**: nothing to sign. Prefer the **`.deb`** (`sudo apt install ./Rico-*.deb`; installs the desktop entry and the Electron sandbox helper correctly). The AppImage needs `chmod +x` and FUSE 2 (`libfuse2`) or `--appimage-extract-and-run`. Checksums for every file are published with each release (`SHA256SUMS.txt`).

## Verify a signed build
`Get-AuthenticodeSignature .\Rico-Setup-*.exe` and `Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\Rico\resources\bin\win-x64\vulkan\llama-server.exe"` must report `Valid`; with Smart App Control **On** the installer must start without a block.

---

**AR.** برنامج «التحكم الذكي بالتطبيقات» (Smart App Control) في ويندوز 11 يمنع أي ملف تنفيذي غير موقّع، ومنها `Rico.exe` والمثبّت و`llama-server.exe` وملفات `.dll`/`.node`. الحل المجاني هو **SignPath Foundation** للمشاريع مفتوحة المصدر: يلزم ترخيص OSI في جذر المستودع (MIT ✔) ومستودع عام وبناء الملفات داخل CI. التفعيل: قدّم الطلب في SignPath، أنشئ المشروع وإعدادات الأرتيفاكت وسياسة التوقيع، ثم أضف السر `SIGNPATH_API_TOKEN` والمتغيرات `SIGNPATH_ORGANIZATION_ID` و`SIGNPATH_PROJECT_SLUG` و`SIGNPATH_SIGNING_POLICY_SLUG`، وأخيرًا فعّل المتغير `SIGNPATH_ENABLED=true`. إلى أن يحدث ذلك تبقى مهمة التوقيع معطّلة ويُبنى المثبّت غير موقّع.
