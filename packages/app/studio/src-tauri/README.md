# openDAW Studio - Desktop Build

This directory contains the Tauri v2 configuration for building openDAW Studio as a native desktop application.

## Supported Platforms

- **Windows**: x64 (NSIS installer, MSI)
- **macOS**: Intel (x64), Apple Silicon (ARM64) (DMG)
- **Linux**: x64 (AppImage, DEB, RPM)

## Prerequisites

### All Platforms
- Node.js >= 23
- Rust (stable)
- npm

### Platform-Specific

#### Windows
- Microsoft Visual Studio C++ Build Tools
- WebView2 (usually pre-installed on Windows 10/11)

#### macOS
- Xcode Command Line Tools: `xcode-select --install`

#### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libasound2-dev
```

#### Linux (Fedora)
```bash
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel gtk3-devel alsa-lib-devel
```

#### Linux (Arch)
```bash
sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg gtk3 alsa-lib
```

## Development

Run the desktop app in development mode:

```bash
# From repository root
npm run tauri:dev

# Or from packages/app/studio
npm run tauri:dev
```

## Building

Build the desktop app for the current platform:

```bash
# From repository root
npm run tauri:build

# Or from packages/app/studio
npm run tauri:build
```

### Build Output

Build artifacts are located at:
- `src-tauri/target/release/bundle/`

## Icon Generation

To regenerate icons from the SVG source:

```bash
npm run tauri:icons
```

For higher quality icons, install sharp first:
```bash
npm install -D sharp
npm run tauri:icons
```

## Configuration

The main configuration file is `tauri.conf.json`. Key settings:

- **productName**: "openDAW Studio"
- **identifier**: "studio.opendaw.app"
- **window**: 1400x900 default size, 800x600 minimum

## Plugins

The desktop app includes these Tauri plugins:
- `tauri-plugin-shell`: Open URLs in default browser
- `tauri-plugin-dialog`: Native file dialogs
- `tauri-plugin-fs`: File system access
- `tauri-plugin-process`: App lifecycle management
- `tauri-plugin-os`: OS information
- `tauri-plugin-http`: HTTP client
- `tauri-plugin-single-instance`: Prevent multiple instances (desktop only)
- `tauri-plugin-updater`: Auto-updates (desktop only)

## Security

The app uses a restrictive Content Security Policy (CSP) to ensure security:
- Only local and whitelisted remote resources are allowed
- WebAssembly execution is enabled for audio processing
- Cross-origin isolation is enabled for SharedArrayBuffer support

## CI/CD

GitHub Actions workflow (`.github/workflows/tauri-build.yml`) automatically builds for all platforms on:
- Push to `main` or `release/*` branches
- Tags matching `v*`
- Manual trigger

Release builds are created as draft releases when version tags are pushed.
