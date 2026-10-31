# The Mac app

The Mac app is the same simulator as the web version, packaged with Electron. It adds a few things a browser tab can't do:

| | Browser | Mac app |
|---|---|---|
| Cloth / soft body / fluid solver | Multithreaded once the page is cross-origin isolated (a service worker handles this on GitHub Pages) | **Always multithreaded**: it uses all but one CPU core |
| GPU | Whatever the browser picks | Asks for the **high-performance GPU** and ignores the GPU blocklist |
| Background tab throttling | Yes | No |
| Frame rate | Capped to the display | Optional uncapped mode (**View → Uncapped Frame Rate**, applies after a restart) |
| Default particle budget | 6,000 | 12,000 |
| Blender | Drag and drop `.glb` files | **Live link**: a watched folder; re-exports reload in place |
| Files | Downloads folder | Native Open / Save dialogs and menus |
| Offline | Once loaded | Always |

The code is identical, so a frame costs the same either way. The app is faster because of threads, GPU choice and no throttling, not a different engine. For a big jump in ray-tracing speed, a native Metal port would be needed. That isn't part of this project.

## Install

1. Download `Physics-Sim-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel). Get it from the repository's **Releases** page, or from a run of the **Mac app (.dmg)** workflow under **Actions → the run → Artifacts**.
2. Open the `.dmg` and drag **Physics Sim** into **Applications**.
3. **First launch:** unless the build was signed with an Apple Developer ID (see below), macOS says it can't verify the developer. Do one of these:
   - In Finder, **right-click** (or Control-click) Physics Sim → **Open** → **Open**. You only do this once.
   - Or in Terminal:

     ```bash
     xattr -dr com.apple.quarantine "/Applications/Physics Sim.app"
     ```

   - On recent macOS versions you may instead need **System Settings → Privacy & Security → Open Anyway**.

## Blender live link

1. Install the Blender add-on (see [BLENDER.md](BLENDER.md)). Its default export folder is `~/Documents/Physics Sim/Blender`.
2. The app watches that same folder from the first launch. To use another folder, go to **File → Blender Live Link Folder…** or **Settings → Blender live link**.
3. In Blender, press **Export for Physics Sim**:
   - A new file is imported into **My models**.
   - A file you've imported before is reloaded. Every placed copy in the scene is swapped for the new version, so you can model in Blender and test in the simulator side by side.

## Building it yourself

The `.dmg` has to be built on a Mac:

```bash
npm ci
```

```bash
npm run dist:mac
```

The `.dmg` files are written to `release/`. To try the app without packaging it:

```bash
npm run desktop
```

### Signing and notarization (optional)

Without signing secrets, the GitHub workflow **ad-hoc signs** the app. It runs, but Gatekeeper asks once on first launch, as described above. To ship a signed and notarized build that opens without warnings, add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | What |
|---|---|
| `CSC_LINK` | Your *Developer ID Application* certificate exported as `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_ID` | Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Your 10-character team id |

Then push a tag (for example `v0.1.0`) or run the workflow by hand.

## Security

- The page runs sandboxed with `contextIsolation`, and Node.js is not available to it.
- It talks to the app only through the small `window.physicsSim` bridge in [`desktop/preload.cts`](../desktop/preload.cts). That bridge offers open/save dialogs, the watched folder and menu commands.
- The app's files are served from a private `app://` origin with a strict Content Security Policy.
- Navigation away from the app is blocked, and web links open in your browser.
