const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createReadStream, statSync } = require('fs');
const path = require('path');

const BUCKET = process.env.TOS_BUCKET || 'nodeskai-public';
const KEY_PREFIX = process.env.TOS_KEY_PREFIX || 'deskclaw/test-pg/';

const accessKeyId = process.env.TOS_ACCESS_KEY_ID;
const secretAccessKey = process.env.TOS_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error('[错误] 未设置 TOS_ACCESS_KEY_ID 或 TOS_SECRET_ACCESS_KEY 环境变量');
  process.exit(1);
}

const tosClient = new S3Client({
  endpoint: process.env.TOS_ENDPOINT || 'https://tos-s3-cn-beijing.volces.com',
  region: process.env.TOS_REGION || 'cn-beijing',
  credentials: { accessKeyId, secretAccessKey },
  signatureVersion: 'v4'
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

async function uploadFile(localFilePath) {
  const resolved = path.resolve(localFilePath);
  const stat = statSync(resolved);
  const objectName = path.basename(resolved);
  const objectKey = `${KEY_PREFIX}${objectName}`;
  const tosPath = `tos://${BUCKET}/${objectKey}`;

  console.log(`[上传] 目标: ${tosPath}`);
  console.log(`[上传] 大小: ${formatBytes(stat.size)}`);

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    Body: createReadStream(resolved),
    ContentType: 'application/octet-stream',
    ContentLength: stat.size,
  });

  const response = await tosClient.send(command);
  console.log(`[上传] 完成 (ETag: ${response.ETag})`);
}

async function main() {
  const filePaths = process.argv.slice(2);
  if (filePaths.length === 0) {
    console.error('[错误] 用法: node upload-to-tos.js <文件路径>');
    process.exit(1);
  }

  let failed = 0;
  for (const fp of filePaths) {
    try {
      await uploadFile(fp);
    } catch (err) {
      console.error(`[错误] ${path.basename(fp)} - ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main();
