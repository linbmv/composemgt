#!/usr/bin/env node

/**
 * WebDAV 备份诊断工具
 * 用于排查"备份成功但列表为空"的问题
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'manager', 'webdav_config.json');

async function main() {
  console.log('🔍 WebDAV 备份诊断工具\n');

  // 1. 读取配置
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ 未找到 WebDAV 配置文件:', CONFIG_PATH);
    console.log('提示: 请先在管理界面完成 WebDAV 配置并保存');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log('✅ WebDAV 配置已加载:');
  console.log('   - URL:', config.url);
  console.log('   - 用户名:', config.username);
  console.log('   - 目录:', config.directory);
  console.log('   - 自动备份:', config.autoBackup ? '已启用' : '已禁用');
  console.log('');

  // 2. 构建完整 URL
  let baseUrl = config.url;
  if (!baseUrl.endsWith('/')) baseUrl += '/';

  let dir = config.directory.replace(/^\/+|\/+$/g, '');
  let fullUrl = baseUrl;
  if (dir) {
    fullUrl += dir + '/';
  }

  console.log('📂 完整目录 URL:', fullUrl);
  console.log('');

  // 3. 构建认证头
  const authHeader = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');

  // 4. 测试 PROPFIND 请求
  console.log('🌐 发送 PROPFIND 请求...');
  try {
    const res = await fetch(fullUrl, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Depth': '1'
      }
    });

    console.log('   - HTTP 状态:', res.status, res.statusText);
    console.log('   - Content-Type:', res.headers.get('content-type'));
    console.log('');

    if (!res.ok) {
      const text = await res.text();
      console.error('❌ PROPFIND 请求失败:');
      console.error(text);
      process.exit(1);
    }

    const xml = await res.text();
    console.log('📋 原始 XML 响应 (前 1000 字符):');
    console.log('─'.repeat(80));
    console.log(xml.substring(0, 1000));
    console.log('─'.repeat(80));
    console.log('');

    // 5. 使用当前正则解析
    console.log('🔍 使用当前正则表达式解析 (修复后的版本):');
    const responseRegex = /<(?:[a-zA-Z0-9]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi;
    const backups = [];
    let match;
    let responseCount = 0;

    while ((match = responseRegex.exec(xml)) !== null) {
      responseCount++;
      const segment = match[0];

      console.log(`\n   响应段 #${responseCount}:`);

      // Extract href
      const hrefMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
      const sizeMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?getcontentlength[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getcontentlength>/i);
      const dateMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?getlastmodified[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getlastmodified>/i);

      if (hrefMatch) {
        const rawHref = hrefMatch[1];
        const decodedHref = decodeURIComponent(rawHref);

        console.log(`   - href (原始): ${rawHref}`);
        console.log(`   - href (解码): ${decodedHref}`);
        console.log(`   - 大小: ${sizeMatch ? sizeMatch[1] + ' bytes' : '未知'}`);
        console.log(`   - 修改时间: ${dateMatch ? dateMatch[1] : '未知'}`);

        // 检查过滤条件
        const isJson = decodedHref.endsWith('.json');
        const hasBackupKeyword = decodedHref.includes('composemgt_backup');

        console.log(`   - 是否 .json 文件: ${isJson}`);
        console.log(`   - 包含 "composemgt_backup": ${hasBackupKeyword}`);

        if (isJson && hasBackupKeyword) {
          const filename = decodedHref.split('/').pop();
          backups.push({
            filename,
            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
            date: dateMatch ? dateMatch[1] : 'Unknown'
          });
          console.log(`   ✅ 匹配备份文件: ${filename}`);
        } else {
          console.log(`   ⚠️  不符合过滤条件，跳过`);
        }
      } else {
        console.log(`   ⚠️  未找到 href 标签`);
      }
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log(`📊 解析结果汇总:`);
    console.log(`   - XML 响应段总数: ${responseCount}`);
    console.log(`   - 匹配的备份文件数: ${backups.length}`);
    console.log('');

    if (backups.length === 0) {
      console.log('❌ 问题诊断:');
      console.log('');
      console.log('   可能原因 1: 文件上传到了错误的目录');
      console.log('      解决方法: 检查 WebDAV 服务器上的实际文件路径');
      console.log('');
      console.log('   可能原因 2: 文件名不符合过滤条件');
      console.log('      当前过滤规则: *.json 且包含 "composemgt_backup"');
      console.log('      备份文件名格式: composemgt_backup_YYYY-MM-DD-HH-mm-ss.json');
      console.log('');
      console.log('   可能原因 3: XML 解析正则仍然有问题');
      console.log('      请将上面的 XML 响应发送给开发者进一步分析');
      console.log('');
      console.log('   可能原因 4: PROPFIND 深度问题');
      console.log('      当前深度: Depth: 1 (列出当前目录及子项)');
      console.log('      如果文件在子目录中,可能需要调整深度或路径');
    } else {
      console.log('✅ 成功找到备份文件:');
      backups.forEach((b, i) => {
        console.log(`   ${i + 1}. ${b.filename}`);
        console.log(`      - 大小: ${(b.size / 1024).toFixed(2)} KB`);
        console.log(`      - 日期: ${b.date}`);
      });
    }

  } catch (error) {
    console.error('❌ 诊断过程中发生错误:');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
