// scripts/verify-zip.mjs — CI verify 用：校验发布 zip 真实性与完整性
// 背景：pack 曾用 `tar -a -cf xxx.zip`，Windows bsdtar 认 zip，但 GNU tar（Linux）
// 不认 .zip 后缀会静默产出 tar 伪 zip（无 PK 头/无 EOCD），安装端报
// "end of central directory record signature not found"。pack 已改 archiver（纯 Node），
// 本脚本在 CI verify 阶段兜底：魔数 + EOCD + sha256 三重校验，缺一即 fail（删 release）。
// 用法：
//   node scripts/verify-zip.mjs <zip> [<sha256-file>]
//   （sha256 文件内容为 hex 摘要，含或不含换行均可；缺省跳过 sha256 对比）
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [zipPath, shaPath] = process.argv.slice(2);
if (!zipPath) {
  console.error("usage: node scripts/verify-zip.mjs <zip> [<sha256-file>]");
  process.exit(2);
}

const buf = readFileSync(zipPath);

// 1. 魔数：本地文件头签名 PK\x03\x04（zip 必以它开头；tar 伪 zip 是文件名/ustar 头）
if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
  console.error(`::error::NOT a zip: ${zipPath} (missing local file header magic PK\\x03\\x04)`);
  process.exit(1);
}

// 2. EOCD：end of central directory record 签名 PK\x05\x06，位于文件尾
//    （记录体 22 字节 + 注释最长 65535 字节，从尾部 65557 字节窗口内搜索）
const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const tail = buf.subarray(Math.max(0, buf.length - 65557));
const eocdAt = tail.lastIndexOf(eocdSig);
if (eocdAt < 0) {
  console.error(`::error::NOT a zip: ${zipPath} (missing end of central directory record)`);
  process.exit(1);
}

// 3. sha256 对比（发布资产自证：zip 摘要必须与 .sha256 文件一致，防上传损坏/串包）
if (shaPath) {
  const expected = readFileSync(shaPath, "utf8").trim().toLowerCase();
  const actual = createHash("sha256").update(buf).digest("hex");
  if (expected !== actual) {
    console.error(`::error::sha256 mismatch for ${zipPath}`);
    console.error(`  expected: ${expected}`);
    console.error(`  actual:   ${actual}`);
    process.exit(1);
  }
  console.log(`sha256 OK: ${actual}`);
}

console.log(`zip OK: ${zipPath} (${buf.length} bytes, EOCD at -${tail.length - eocdAt})`);
