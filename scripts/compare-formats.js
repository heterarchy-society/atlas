const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Get the input image from command line arguments
const inputImage = process.argv[2];

if (!inputImage) {
  console.error("❌ Please provide an input image. Example: node compare.js my-photo.png");
  process.exit(1);
}

if (!fs.existsSync(inputImage)) {
  console.error(`❌ File not found: ${inputImage}`);
  process.exit(1);
}

// Utility function to format bytes nicely
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function compareFormats() {
  const ext = path.extname(inputImage);
  const base = path.basename(inputImage, ext);
  const originalSize = fs.statSync(inputImage).size;

  console.log(`\nAnalyzing: ${inputImage}`);
  console.log(`Original Size: ${formatBytes(originalSize)}\n`);
  console.log("Converting images... Hang tight (AVIF might take a few seconds)...");

  // Define outputs
  const targets = [
    { name: 'WebP (Lossless)', ext: '.webp', options: { lossless: true } },
    { name: 'WebP (Optimized/Lossy)', ext: '_lossy.webp', options: { quality: 80 } },
    { name: 'AVIF (Lossless)', ext: '.avif', options: { lossless: true } },
    { name: 'AVIF (Optimized/Lossy)', ext: '_lossy.avif', options: { quality: 65 } } // 65 AVIF ≈ 80 WebP quality
  ];

  const results = [
    {
      'Format': 'Original Source',
      'File Size': formatBytes(originalSize),
      'Savings %': '-'
    }
  ];

  for (const target of targets) {
    const outputPath = path.join(process.cwd(), `${base}${target.ext}`);
    
    try {
      let pipeline = sharp(inputImage);

      // Apply format specific settings
      if (target.name.includes('WebP')) {
        pipeline = pipeline.webp(target.options);
      } else if (target.name.includes('AVIF')) {
        // effort 4 balances speed and compression efficiency
        pipeline = pipeline.avif({ ...target.options, effort: 4 });
      }

      await pipeline.toFile(outputPath);

      const newSize = fs.statSync(outputPath).size;
      const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);

      results.push({
        'Format': target.name,
        'File Size': formatBytes(newSize),
        'Savings %': savings > 0 ? `-${savings}%` : `+${Math.abs(savings)}%`
      });

    } catch (err) {
      results.push({
        'Format': target.name,
        'File Size': 'Error during conversion',
        'Savings %': 'N/A'
      });
    }
  }

  // Display the comparison in a clean table
  console.clear();
  console.log(`\n📊 Image Format Comparison Results:`);
  console.table(results);
  console.log(`\nGenerated files are saved in your current directory.`);
}

compareFormats();
