const fs = require("fs");
const path = require("path");

const samplePath = path.join(__dirname, "o3de-api.sample.json");
process.stdout.write(fs.readFileSync(samplePath, "utf8"));
