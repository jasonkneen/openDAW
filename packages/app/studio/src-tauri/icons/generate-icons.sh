#!/bin/bash
# Icon generation script for openDAW Studio
# Requires: inkscape or rsvg-convert, and icotool/png2icns

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVG_SOURCE="$SCRIPT_DIR/../../public/favicon.svg"

# Check for required tools
if command -v rsvg-convert &> /dev/null; then
    CONVERTER="rsvg-convert"
elif command -v inkscape &> /dev/null; then
    CONVERTER="inkscape"
else
    echo "Error: Please install rsvg-convert (librsvg) or inkscape"
    exit 1
fi

echo "Using $CONVERTER for SVG conversion"

# Create colored background version for better visibility
# The original SVG has gray (#ddd) on transparent background
# For icons, we'll use a dark background

# Generate PNG icons at required sizes
generate_png() {
    local size=$1
    local output=$2

    if [ "$CONVERTER" = "rsvg-convert" ]; then
        rsvg-convert -w "$size" -h "$size" "$SVG_SOURCE" -o "$output"
    else
        inkscape -w "$size" -h "$size" "$SVG_SOURCE" -o "$output"
    fi
    echo "Generated: $output"
}

# Generate all required PNG sizes
generate_png 32 "$SCRIPT_DIR/32x32.png"
generate_png 128 "$SCRIPT_DIR/128x128.png"
generate_png 256 "$SCRIPT_DIR/128x128@2x.png"
generate_png 512 "$SCRIPT_DIR/icon.png"

# Generate macOS .icns file
if command -v png2icns &> /dev/null; then
    # Generate all sizes needed for icns
    generate_png 16 "$SCRIPT_DIR/icon_16x16.png"
    generate_png 32 "$SCRIPT_DIR/icon_16x16@2x.png"
    generate_png 32 "$SCRIPT_DIR/icon_32x32.png"
    generate_png 64 "$SCRIPT_DIR/icon_32x32@2x.png"
    generate_png 128 "$SCRIPT_DIR/icon_128x128.png"
    generate_png 256 "$SCRIPT_DIR/icon_128x128@2x.png"
    generate_png 256 "$SCRIPT_DIR/icon_256x256.png"
    generate_png 512 "$SCRIPT_DIR/icon_256x256@2x.png"
    generate_png 512 "$SCRIPT_DIR/icon_512x512.png"
    generate_png 1024 "$SCRIPT_DIR/icon_512x512@2x.png"

    png2icns "$SCRIPT_DIR/icon.icns" \
        "$SCRIPT_DIR/icon_16x16.png" \
        "$SCRIPT_DIR/icon_32x32.png" \
        "$SCRIPT_DIR/icon_128x128.png" \
        "$SCRIPT_DIR/icon_256x256.png" \
        "$SCRIPT_DIR/icon_512x512.png"

    # Cleanup temporary files
    rm -f "$SCRIPT_DIR/icon_*.png"
    echo "Generated: icon.icns"
elif command -v iconutil &> /dev/null; then
    # macOS native tool
    ICONSET_DIR="$SCRIPT_DIR/icon.iconset"
    mkdir -p "$ICONSET_DIR"

    generate_png 16 "$ICONSET_DIR/icon_16x16.png"
    generate_png 32 "$ICONSET_DIR/icon_16x16@2x.png"
    generate_png 32 "$ICONSET_DIR/icon_32x32.png"
    generate_png 64 "$ICONSET_DIR/icon_32x32@2x.png"
    generate_png 128 "$ICONSET_DIR/icon_128x128.png"
    generate_png 256 "$ICONSET_DIR/icon_128x128@2x.png"
    generate_png 256 "$ICONSET_DIR/icon_256x256.png"
    generate_png 512 "$ICONSET_DIR/icon_256x256@2x.png"
    generate_png 512 "$ICONSET_DIR/icon_512x512.png"
    generate_png 1024 "$ICONSET_DIR/icon_512x512@2x.png"

    iconutil -c icns "$ICONSET_DIR"
    rm -rf "$ICONSET_DIR"
    echo "Generated: icon.icns"
else
    echo "Warning: Cannot generate .icns file. Install png2icns or use macOS iconutil"
fi

# Generate Windows .ico file
if command -v icotool &> /dev/null; then
    # Generate required sizes for ICO
    generate_png 16 "$SCRIPT_DIR/icon_16.png"
    generate_png 24 "$SCRIPT_DIR/icon_24.png"
    generate_png 32 "$SCRIPT_DIR/icon_32.png"
    generate_png 48 "$SCRIPT_DIR/icon_48.png"
    generate_png 64 "$SCRIPT_DIR/icon_64.png"
    generate_png 256 "$SCRIPT_DIR/icon_256.png"

    icotool -c -o "$SCRIPT_DIR/icon.ico" \
        "$SCRIPT_DIR/icon_16.png" \
        "$SCRIPT_DIR/icon_24.png" \
        "$SCRIPT_DIR/icon_32.png" \
        "$SCRIPT_DIR/icon_48.png" \
        "$SCRIPT_DIR/icon_64.png" \
        "$SCRIPT_DIR/icon_256.png"

    # Cleanup
    rm -f "$SCRIPT_DIR/icon_*.png"
    echo "Generated: icon.ico"
elif command -v convert &> /dev/null; then
    # ImageMagick
    generate_png 256 "$SCRIPT_DIR/icon_256.png"
    convert "$SCRIPT_DIR/icon_256.png" -define icon:auto-resize=256,128,64,48,32,16 "$SCRIPT_DIR/icon.ico"
    rm -f "$SCRIPT_DIR/icon_256.png"
    echo "Generated: icon.ico (via ImageMagick)"
else
    echo "Warning: Cannot generate .ico file. Install icotool or ImageMagick"
fi

echo ""
echo "Icon generation complete!"
echo "Note: For best results, create a custom icon with a solid background."
