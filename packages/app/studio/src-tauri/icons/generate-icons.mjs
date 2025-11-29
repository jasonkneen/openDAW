#!/usr/bin/env node
/**
 * Icon generation script for openDAW Studio
 * Creates PNG icons from SVG source
 *
 * For full functionality, install sharp: npm install sharp
 * This script will create placeholder icons if sharp is not available
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(__dirname, '../../public/favicon.svg');

// CRC32 implementation for PNG
function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = [];

    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }

    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const typeBuffer = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);

    return Buffer.concat([length, typeBuffer, data, crc]);
}

// Create placeholder PNG with openDAW-style icon pattern
function createPlaceholderPng(size) {
    // PNG signature
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR chunk
    const width = size;
    const height = size;
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 2;  // color type (RGB)
    ihdrData[10] = 0; // compression
    ihdrData[11] = 0; // filter
    ihdrData[12] = 0; // interlace
    const ihdr = createChunk('IHDR', ihdrData);

    // IDAT chunk - create openDAW logo pattern
    const rawData = [];
    const padding = Math.floor(size * 0.04); // 4% padding

    for (let y = 0; y < height; y++) {
        rawData.push(0); // filter byte for each row
        for (let x = 0; x < width; x++) {
            // Normalize coordinates to 0-24 (SVG viewBox)
            const nx = (x / size) * 24;
            const ny = (y / size) * 24;

            // Left bar: x 1-8, y 1-23
            const leftBar = nx >= 1 && nx <= 8 && ny >= 1 && ny <= 23;

            // Top right outline box: x 10-23, y 1-13
            const topRightOuter = nx >= 10 && nx <= 23 && ny >= 1 && ny <= 13;
            const topRightInner = nx >= 11 && nx <= 22 && ny >= 2 && ny <= 12;
            const topRightBox = topRightOuter && !topRightInner;

            // Bottom right filled box: x 10-23, y 15-23
            const bottomRightBox = nx >= 10 && nx <= 23 && ny >= 15 && ny <= 23;

            const isIcon = leftBar || topRightBox || bottomRightBox;

            if (isIcon) {
                rawData.push(221, 221, 221); // #DDD (matches SVG)
            } else {
                rawData.push(30, 30, 35); // Dark background #1e1e23
            }
        }
    }

    const compressed = deflateSync(Buffer.from(rawData));
    const idat = createChunk('IDAT', compressed);

    // IEND chunk
    const iend = createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdr, idat, iend]);
}

function createIcoFromPng(pngData) {
    // ICO file format with embedded PNG
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);      // Reserved
    header.writeUInt16LE(1, 2);      // Type: 1 = ICO
    header.writeUInt16LE(1, 4);      // Number of images

    const dirEntry = Buffer.alloc(16);
    dirEntry[0] = 0;                  // Width (0 = 256)
    dirEntry[1] = 0;                  // Height (0 = 256)
    dirEntry[2] = 0;                  // Color palette
    dirEntry[3] = 0;                  // Reserved
    dirEntry.writeUInt16LE(1, 4);     // Color planes
    dirEntry.writeUInt16LE(32, 6);    // Bits per pixel
    dirEntry.writeUInt32LE(pngData.length, 8);   // Size of image data
    dirEntry.writeUInt32LE(22, 12);   // Offset to image data

    return Buffer.concat([header, dirEntry, pngData]);
}

function createIcnsFromPng(pngData) {
    // ICNS file format with ic09 (512x512 PNG)
    const magic = Buffer.from('icns');
    const type = Buffer.from('ic09'); // 512x512 PNG

    const iconSize = Buffer.alloc(4);
    iconSize.writeUInt32BE(pngData.length + 8, 0);

    const totalSize = Buffer.alloc(4);
    totalSize.writeUInt32BE(pngData.length + 16, 0);

    return Buffer.concat([magic, totalSize, type, iconSize, pngData]);
}

async function generateIcons() {
    let useSharp = false;
    let sharp;

    try {
        sharp = (await import('sharp')).default;
        useSharp = true;
        console.log('Using sharp for high-quality icon generation');
    } catch {
        console.log('Sharp not available, creating placeholder icons');
        console.log('For high-quality icons, run: npm install -D sharp\n');
    }

    const sizes = {
        '32x32.png': 32,
        '128x128.png': 128,
        '128x128@2x.png': 256,
        'icon.png': 512,
    };

    const svgContent = readFileSync(svgPath, 'utf8');

    // Add a dark background to the SVG for better visibility
    const svgWithBg = svgContent.replace(
        '<svg ',
        '<svg style="background-color: #1e1e23" '
    );

    for (const [filename, size] of Object.entries(sizes)) {
        const outputPath = resolve(__dirname, filename);

        if (useSharp) {
            const svgBuffer = Buffer.from(svgWithBg);
            await sharp(svgBuffer)
                .resize(size, size)
                .png()
                .toFile(outputPath);
        } else {
            const png = createPlaceholderPng(size);
            writeFileSync(outputPath, png);
        }

        console.log(`Generated: ${filename} (${size}x${size})`);
    }

    // Create ICO file (Windows)
    const icon256 = useSharp
        ? await sharp(Buffer.from(svgWithBg)).resize(256, 256).png().toBuffer()
        : createPlaceholderPng(256);

    const icoBuffer = createIcoFromPng(icon256);
    writeFileSync(resolve(__dirname, 'icon.ico'), icoBuffer);
    console.log('Generated: icon.ico');

    // Create ICNS file (macOS)
    const icon512 = useSharp
        ? await sharp(Buffer.from(svgWithBg)).resize(512, 512).png().toBuffer()
        : createPlaceholderPng(512);

    const icnsBuffer = createIcnsFromPng(icon512);
    writeFileSync(resolve(__dirname, 'icon.icns'), icnsBuffer);
    console.log('Generated: icon.icns');

    console.log('\nIcon generation complete!');
}

generateIcons().catch(console.error);
