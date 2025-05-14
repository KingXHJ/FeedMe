// 命令行脚本，用于更新所有RSS源数据
// 供GitHub Actions直接调用

// 加载.env文件中的环境变量
const path = require('path');
const fs = require('fs');
const dotenvPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(dotenvPath)) {
  const dotenvContent = fs.readFileSync(dotenvPath, 'utf8');
  dotenvContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.replace(/^"|"$/g, '');
      }
      process.env[key] = value;
    }
  });
  console.log('已从.env加载环境变量');
} else {
  // 尝试加载.env.local作为后备
  const localEnvPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(localEnvPath)) {
    const dotenvContent = fs.readFileSync(localEnvPath, 'utf8');
    dotenvContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.replace(/^"|"$/g, '');
        }
        process.env[key] = value;
      }
    });
    console.log('已从.env.local加载环境变量');
  } else {
    console.warn('未找到.env或.env.local文件，请确保环境变量已设置');
  }
}

const Parser = require('rss-parser');

// 从配置文件中导入RSS源配置
const { config } = require('../config/rss-config.js');

// RSS解析器配置
const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "content"],
      ["dc:creator", "creator"],
    ],
  },
});

// 从环境变量中获取API配置
const GEMINI_API_KEY = process.env.LLM_API_KEY;
const GEMINI_API_BASE = process.env.LLM_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODEL_NAME = process.env.LLM_NAME || 'gemini-2.0-flash';

// 验证必要的环境变量
if (!GEMINI_API_KEY) {
  console.error('环境变量LLM_API_KEY未设置，无法生成摘要');
  process.exit(1);
}

if (!GEMINI_API_BASE) {
  console.error('环境变量LLM_API_BASE未设置，无法生成摘要');
  process.exit(1);
}

if (!GEMINI_MODEL_NAME) {
  console.error('环境变量LLM_NAME未设置，无法生成摘要');
  process.exit(1);
}

// 确保数据目录存在
function ensureDataDir() {
  const dataDir = path.join(process.cwd(), config.dataPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

// 获取源的文件路径
function getSourceFilePath(sourceUrl) {
  const dataDir = ensureDataDir();
  // 使用URL的Base64编码作为文件名，避免非法字符
  const sourceHash = Buffer.from(sourceUrl).toString('base64').replace(/[/+=]/g, '_');
  return path.join(dataDir, `${sourceHash}.json`);
}

// 保存源数据到文件
async function saveFeedData(sourceUrl, data) {
  const filePath = getSourceFilePath(sourceUrl);

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`保存数据 ${sourceUrl} 到 ${filePath}`);
  } catch (error) {
    console.error(`保存数据 ${sourceUrl} 时出错:`, error);
    throw new Error(`保存源数据失败: ${error.message}`);
  }
}

// 从文件加载源数据
function loadFeedData(sourceUrl) {
  const filePath = getSourceFilePath(sourceUrl);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`加载数据 ${sourceUrl} 时出错:`, error);
    return null;
  }
}

// Gemini API请求队列配置（全局控制）
const PQueue = require('p-queue');
const retry = require('p-retry');

// API请求队列配置（全局控制）
const apiQueue = new PQueue({
  concurrency: 3, // 最大并发数
  intervalCap: 15, // 每分钟15次
  interval: 60 * 1000, // 每分钟间隔
});

// 重试配置
const RETRY_CONFIG = {
  retries: 3,
  minTimeout: 2000,
  factor: 2,
};

// Token估算系数（按字符粗略估算）
const TOKEN_PER_CHAR = 0.4;
let currentMinuteTokens = 0;
let lastResetTime = Date.now();

// 带速率限制的摘要生成
async function generateSummaryWithLimit(title, content) {
  // 清理内容 - 添加更严格的清理
  const cleanContent = content
    .replace(/<[^>]*>?/gm, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, 3000); // 更严格长度限制

  // 准备提示词
  const prompt = `
你是一个专业的内容摘要生成器。请根据以下文章标题和内容，生成一个简洁、准确的中文摘要。
摘要应该：
1. 捕捉文章的主要观点和关键信息
2. 使用清晰、流畅的中文
3. 长度控制在100字左右
4. 保持客观，不添加个人观点
5. 如果文章内容为空或不包含有效信息，不要生成文章标题或内容未提及的无关内容。对非中文的标题进行翻译，不需要翻译中文的标题

文章标题：${title}

文章内容：
${cleanContent.slice(0, 5000)} // 限制内容长度以避免超出token限制
`;

  try {
    const apiUrl = `${GEMINI_API_BASE}${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await apiQueue.add(() =>
      fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 300
          }
        })
      })
    );

    if (response.status === 429) {
      throw new retry.AbortError('API速率限制已触发');
    }

    if (!response.ok) {
      throw new Error(`API错误: ${response.status}`);
    }

    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "无有效摘要生成";
  } catch (error) {
    console.error("API请求失败:", error);
    throw error;
  }
}

// 获取RSS源
async function fetchRssFeed(url) {
  try {
    // 直接解析RSS URL
    const feed = await parser.parseURL(url);

    // 处理items，确保所有对象都是可序列化的纯对象
    const serializedItems = feed.items.map(item => {
      // 创建新的纯对象
      const serializedItem = {
        title: item.title || "",
        link: item.link || "",
        pubDate: item.pubDate || "",
        isoDate: item.isoDate || "",
        content: item.content || "",
        contentSnippet: item.contentSnippet || "",
        creator: item.creator || "",
      };
      
      // 如果存在enclosure，以纯对象形式添加
      if (item.enclosure) {
        serializedItem.enclosure = {
          url: item.enclosure.url || "",
          type: item.enclosure.type || "",
        };
      }
      
      return serializedItem;
    });

    return {
      title: feed.title || "",
      description: feed.description || "",
      link: feed.link || "",
      items: serializedItems,
    };
  } catch (error) {
    console.error("获取RSS源时出错:", error);
    throw new Error(`获取RSS源失败: ${error.message}`);
  }
}

// 合并新旧数据，并找出需要生成摘要的新条目
function mergeFeedItems(oldItems = [], newItems = [], maxItems = config.maxItemsPerFeed) {
  // 创建一个Map来存储所有条目，使用链接作为键
  const itemsMap = new Map();

  // 添加旧条目到Map
  for (const item of oldItems) {
    if (item.link) {
      itemsMap.set(item.link, item);
    }
  }

  // 识别需要生成摘要的新条目
  const newItemsForSummary = [];

  // 添加新条目到Map，并标记需要生成摘要的条目
  for (const item of newItems) {
    if (item.link) {
      const existingItem = itemsMap.get(item.link);

      if (!existingItem) {
        // 这是一个新条目，需要生成摘要
        newItemsForSummary.push(item);
      }

      // 无论如何都更新Map，使用新条目（但保留旧摘要如果有的话）
      const serializedItem = {
        ...item,
        summary: existingItem?.summary || item.summary,
      };
      
      itemsMap.set(item.link, serializedItem);
    }
  }

  // 将Map转换回数组，保持原始RSS源的顺序
  // 使用newItems的顺序作为基准
  const mergedItems = newItems
    .filter(item => item.link && itemsMap.has(item.link))
    .map(item => item.link ? itemsMap.get(item.link) : item)
    .slice(0, maxItems); // 只保留指定数量的条目

  return { mergedItems, newItemsForSummary };
}

// 更新单个源（新增节流控制）
async function updateFeed(sourceUrl) {
  console.log(`更新源: ${sourceUrl}`);
  
  try {
    // 检查token限额
    const now = Date.now();
    if (now - lastResetTime > 60 * 1000) {
      currentMinuteTokens = 0;
      lastResetTime = now;
    }

    // 获取现有数据
    const existingData = loadFeedData(sourceUrl);

    // 获取新数据
    const newFeed = await fetchRssFeed(sourceUrl);

    // 合并数据，找出需要生成摘要的新条目
    const { mergedItems, newItemsForSummary } = mergeFeedItems(
      existingData?.items || [],
      newFeed.items,
      config.maxItemsPerFeed,
    );

    console.log(`发现 ${newItemsForSummary.length} 条新条目，来自 ${sourceUrl}`);

    // 处理摘要生成（带速率控制）
    const itemsWithSummaries = [];
    for (const item of mergedItems) {
      const isNewItem = newItemsForSummary.some(newItem => newItem.link === item.link);
      
      if (isNewItem && !item.summary) {
        // 估算token消耗
        const promptLength = (item.title + item.content).length;
        const estimatedTokens = Math.floor(promptLength * TOKEN_PER_CHAR);
        
        // 检查token限额
        if (currentMinuteTokens + estimatedTokens > 900000) { // 保留100k余量
          console.warn('接近token限额，暂停处理');
          await delay(60000 - (Date.now() - lastResetTime));
          currentMinuteTokens = 0;
          lastResetTime = Date.now();
        }
        
        try {
          const summary = await retry(
            () => generateSummaryWithLimit(item.title, item.content),
            RETRY_CONFIG
          );
          
          currentMinuteTokens += estimatedTokens;
          itemsWithSummaries.push({ ...item, summary });
        } catch (error) {
          console.error(`为条目生成摘要失败: ${item.title}`, error);
          itemsWithSummaries.push({ ...item, summary: "摘要生成失败（请稍后重试）" });
        }
      } else {
        itemsWithSummaries.push(item);
      }
    }

    // 创建新的数据对象
    const updatedData = {
      sourceUrl,
      title: newFeed.title,
      description: newFeed.description,
      link: newFeed.link,
      items: itemsWithSummaries,
      lastUpdated: new Date().toISOString(),
    };

    // 保存到文件
    await saveFeedData(sourceUrl, updatedData);

    return updatedData;
  } catch (error) {
    console.error(`更新源 ${sourceUrl} 时出错:`, error);
    throw error;
  }
}

// 更新所有源
async function updateAllFeeds() {
  console.log("开始更新所有RSS源");

  const results = {};

  for (const source of config.sources) {
    try {
      await updateFeed(source.url);
      results[source.url] = true;
    } catch (error) {
      console.error(`更新 ${source.url} 失败:`, error);
      results[source.url] = false;
    }
  }

  console.log("所有RSS源更新完成");
  return results;
}

// 主函数
async function main() {
  try {
    await updateAllFeeds();
    console.log("RSS数据更新成功");
    process.exit(0);
  } catch (error) {
    console.error("RSS数据更新失败:", error);
    process.exit(1);
  }
}

// 执行主函数
main(); 