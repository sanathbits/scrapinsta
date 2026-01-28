import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import puppeteer from "puppeteer";
import dotenv from "dotenv";

const execAsync = promisify(exec);

dotenv.config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Global JSON log for processed reel links
const ALL_REEL_PATH = path.resolve(process.cwd(), "output", "Allreel.json");
const DOWNLOAD_DIR = path.join(process.env.HOME || process.cwd(), "Downloads");

async function loadAllReels() {
  try {
    const raw = await fs.readFile(ALL_REEL_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // File missing or invalid JSON – start fresh.
    return [];
  }
}

async function saveAllReels(entries) {
  await fs.mkdir(path.dirname(ALL_REEL_PATH), { recursive: true });
  await fs.writeFile(ALL_REEL_PATH, JSON.stringify(entries, null, 2), "utf8");
}

async function upsertReelEntry(linkUrl, mutate) {
  const list = await loadAllReels();
  let entry = list.find((e) => e.linkUrl === linkUrl);
  if (!entry) {
    entry = {
      linkUrl,
      downloaded: false,
      filePath: null,
      mp3FilePath: null,
      isConverted: false,
      lastUpdated: new Date().toISOString(),
    };
    list.push(entry);
  }
  if (typeof mutate === "function") {
    mutate(entry);
    entry.lastUpdated = new Date().toISOString();
  }
  await saveAllReels(list);
  return entry;
}

async function getLatestDownloadedFile() {
  try {
    const files = await fs.readdir(DOWNLOAD_DIR);
    if (!files.length) return null;

    let latest = null;
    for (const name of files) {
      const fullPath = path.join(DOWNLOAD_DIR, name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { fileName: name, filePath: fullPath, mtimeMs: stat.mtimeMs, isConverted: false };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

async function dirHasFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function resolveProfileDir() {
  const raw = process.env.PROFILE_DIR || "./chrome-profile";
  return path.resolve(process.cwd(), raw);
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeCount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Examples: "338", "1,234", "12.3K", "4.5M"
  const m = s.match(/^([\d.,]+)\s*([KM])?$/i);
  if (!m) return null;
  const num = parseFloat(m[1].replaceAll(",", ""));
  if (Number.isNaN(num)) return null;
  const suffix = (m[2] || "").toUpperCase();
  const mult = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1;
  return Math.round(num * mult);
}

function parseProfileStatsFromHtml(html) {
  // Best source: <meta name="description" content="... X Followers, Y Following, Z Posts ...">
  // Instagram varies locale/format, so we match case-insensitive keyword chunks.
  const meta = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  const content = decodeHtmlEntities(meta?.[1] || "");

  const find = (label) => {
    const r = new RegExp(String.raw`([\d.,]+\s*[KM]?)\s+${label}`, "i");
    const mm = content.match(r);
    return mm?.[1] || null;
  };

  const followersRaw = find("followers?");
  const followingRaw = find("following");
  const postsRaw = find("posts?");

  return {
    source: content ? "meta:description" : "none",
    postsRaw,
    followersRaw,
    followingRaw,
    posts: normalizeCount(postsRaw),
    followers: normalizeCount(followersRaw),
    following: normalizeCount(followingRaw),
  };
}

async function extractProfileStats(page, html) {
  const fromHtml = parseProfileStatsFromHtml(html);
  if (
    fromHtml.posts != null ||
    fromHtml.followers != null ||
    fromHtml.following != null
  ) {
    return fromHtml;
  }

  // Fallback: parse visible text from the rendered DOM.
  const fromText = await page
    .evaluate(() => {
      const headerText =
        document.querySelector("header")?.innerText ||
        document.querySelector("main")?.innerText ||
        document.body?.innerText ||
        "";
      return headerText;
    })
    .catch(() => "");

  const findInText = (label) => {
    const r = new RegExp(String.raw`([\d.,]+\s*[KM]?)\s+${label}`, "i");
    const mm = String(fromText || "").match(r);
    return mm?.[1] || null;
  };

  const followersRaw = findInText("followers?");
  const followingRaw = findInText("following");
  const postsRaw = findInText("posts?");

  return {
    source: "dom:visibleText",
    postsRaw,
    followersRaw,
    followingRaw,
    posts: normalizeCount(postsRaw),
    followers: normalizeCount(followersRaw),
    following: normalizeCount(followingRaw),
  };
}

async function safeScreenshot(page, filePath, fullPage = true) {
  // Some Puppeteer builds can transiently report 0x0 layout early in navigation.
  // This helper retries briefly and never fails the whole run.
  for (let i = 0; i < 5; i++) {
    try {
      const dims = await page
        .evaluate(() => ({
          w: document.documentElement?.clientWidth || 0,
          h: document.documentElement?.clientHeight || 0,
        }))
        .catch(() => ({ w: 0, h: 0 }));
      if (dims.w > 0 && dims.h > 0) {
        await page.screenshot({ path: filePath, fullPage });
        return true;
      }
    } catch {
      // retry
    }
    await sleep(250);
  }

  try {
    // Last attempt anyway; if it fails, swallow.
    await page.screenshot({ path: filePath, fullPage });
    return true;
  } catch (e) {
    console.warn(
      `Warning: screenshot failed for ${filePath}: ${e?.message || e}`
    );
    return false;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getArgUrl() {
  const arg = process.argv.slice(2).find((x) => x && !x.startsWith("-"));
  return arg || process.env.TARGET_URL || "https://www.instagram.com/";
}

function tsDirName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours()
  )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function clickButtonByExactText(page, text, timeoutMs = 2000) {
  // Avoid Puppeteer XPath helpers ($x) since they're not available in some versions/builds.
  // Best-effort: find a clickable element whose visible textContent matches exactly and click it.
  const clicked = await page
    .waitForFunction(
      (t) => {
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"]')
        );
        const btn = candidates.find((b) => (b.textContent || "").trim() === t);
        if (!btn) return false;
        btn.click();
        return true;
      },
      { timeout: timeoutMs },
      text
    )
    .then(() => true)
    .catch(() => false);

  return clicked;
}

async function handleCommonInstagramPostLoginDialogs(page) {
  // These dialogs vary by locale/account. Best-effort.
  await clickButtonByExactText(page, "Not Now").catch(() => {});
  await clickButtonByExactText(page, "Not now").catch(() => {});
}

async function isInstagramLoggedIn(page) {
  return await page
    .evaluate(() => {
      const hasLoginForm =
        !!document.querySelector('input[name="username"]') ||
        !!document.querySelector('input[name="password"]');
      if (hasLoginForm) return false;

      const hasLoggedInUi =
        !!document.querySelector('a[href^="/direct/"]') ||
        !!document.querySelector('svg[aria-label="Home"]') ||
        !!document.querySelector('svg[aria-label="Direct"]') ||
        !!document.querySelector('svg[aria-label="New post"]') ||
        !!document.querySelector('a[href="/explore/"]');
      return hasLoggedInUi;
    })
    .catch(() => false);
}

async function waitForManualLogin(page, timeoutMs = 10 * 60 * 1000) {
  await page.waitForFunction(
    () => {
      const href = location.href;
      if (href.includes("/challenge") || href.includes("/two_factor"))
        return true;

      const hasLoginForm =
        !!document.querySelector('input[name="username"]') ||
        !!document.querySelector('input[name="password"]');
      if (!hasLoginForm) return true;

      const hasLoggedInUi =
        !!document.querySelector('a[href^="/direct/"]') ||
        !!document.querySelector('svg[aria-label="Home"]') ||
        !!document.querySelector('svg[aria-label="Direct"]') ||
        !!document.querySelector('svg[aria-label="New post"]');
      return hasLoggedInUi;
    },
    { timeout: timeoutMs }
  );
}

async function waitForInstagramLoggedIn(page) {
  // Don't rely only on URL (e.g. /?flo=true). Wait for UI change:
  // - login form disappears OR
  // - logged-in nav UI appears OR
  // - we land on a challenge/2FA page.
  await page.waitForFunction(
    () => {
      const href = location.href;
      if (href.includes("/challenge") || href.includes("/two_factor"))
        return true;

      const hasLoginForm =
        !!document.querySelector('input[name="username"]') ||
        !!document.querySelector('input[name="password"]');
      if (!hasLoginForm) return true;

      const hasLoggedInUi =
        !!document.querySelector('a[href^="/direct/"]') ||
        !!document.querySelector('svg[aria-label="Home"]') ||
        !!document.querySelector('svg[aria-label="Direct"]') ||
        !!document.querySelector('svg[aria-label="New post"]');
      return hasLoggedInUi;
    },
    { timeout: 60_000 }
  );
}

async function loginInstagram(page, username, password, outDir) {
  // Never log passwords to console.
  console.log(`Logging in to Instagram... user=${username}`);
  // Always start from the dedicated login page; /?flo=true can break login detection.
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "domcontentloaded",
  });

  // Cookie banners can block interactions. Best-effort dismissals.
  await clickButtonByExactText(page, "Allow all cookies", 1500).catch(() => {});
  await clickButtonByExactText(
    page,
    "Only allow essential cookies",
    1500
  ).catch(() => {});
  await clickButtonByExactText(page, "Accept all", 1500).catch(() => {});

  if (process.env.DEBUG_LOGIN === "1") {
    await safeScreenshot(page, path.join(outDir, "login-01-loaded.png"), true);
  }

  await page.waitForSelector('input[name="username"]', { timeout: 30_000 });
  await page.click('input[name="username"]', { clickCount: 3 });
  await page.type('input[name="username"]', username, { delay: 20 });

  await page.waitForSelector('input[name="password"]', { timeout: 30_000 });
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', password, { delay: 20 });

  if (process.env.DEBUG_LOGIN === "1") {
    await safeScreenshot(page, path.join(outDir, "login-02-filled.png"), true);
  }

  // Wait until submit is enabled (Instagram disables it until inputs are valid).
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('button[type="submit"]');
        return !!b && !(b instanceof HTMLButtonElement && b.disabled);
      },
      { timeout: 10_000 }
    )
    .catch(() => {});

  const clicked =
    (await clickButtonByExactText(page, "Log in", 3000)) ||
    (await clickButtonByExactText(page, "Log In", 3000));
  if (!clicked) {
    await page.click('button[type="submit"]');
  }

  // If a checkpoint/2FA/captcha appears, this will likely stall; run with HEADFUL=1 to complete manually.
  await waitForInstagramLoggedIn(page);

  if (process.env.DEBUG_LOGIN === "1") {
    await safeScreenshot(
      page,
      path.join(outDir, "login-03-after-submit.png"),
      true
    );
  }

  // If we're still on the login form, surface any error message.
  const loginError = await page
    .evaluate(() => {
      const alert = document.querySelector('[role="alert"]');
      const t = (alert?.textContent || "").trim();
      return t || null;
    })
    .catch(() => null);
  if (loginError) throw new Error(`Instagram login failed: ${loginError}`);

  await handleCommonInstagramPostLoginDialogs(page);
}

async function extractCssText(page) {
  // Best-effort: inline <style> + same-origin stylesheet rules (cross-origin rules often throw due to CORS).
  return await page.evaluate(() => {
    const chunks = [];

    for (const styleEl of Array.from(document.querySelectorAll("style"))) {
      if (styleEl.textContent?.trim()) chunks.push(styleEl.textContent);
    }

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules;
        if (!rules) continue;
        const css = Array.from(rules)
          .map((r) => r.cssText)
          .join("\n");
        if (css.trim()) chunks.push(css);
      } catch {
        // ignore cross-origin stylesheets
      }
    }

    return chunks.join("\n\n/* ---- */\n\n");
  });
}

// async function extractUserHrefPaths(page, username, limit = 200) {
//   const prefix = `/${username}/`;
//   const hrefs = await page
//     .evaluate(
//       ({ pfx, lim }) => {
//         const out = [];
//         const seen = new Set();
//         const anchors = Array.from(document.querySelectorAll("a[href]"));
//         for (const a of anchors) {
//           const h = a.getAttribute("href") || "";
//           if (!h.startsWith(pfx)) continue;
//           if (seen.has(h)) continue;
//           seen.add(h);
//           out.push(h);
//           if (out.length >= lim) break;
//         }
//         return out;
//       },
//       { pfx: prefix, lim: limit }
//     )
//     .catch(() => []);

//   return { prefix, hrefs };
// }

async function extractUserHrefPaths(page, username, limit = 200) {
  const prefix = `/${username}/reel/`;

  return await page.evaluate(
    ({ prefix, limit }) => {
      const results = [];
      const seen = new Set();

      const isCountToken = (t) => /^\d+(?:[.,]\d+)?[KMB]?$/i.test(t);
      const cleanToken = (t) => (t || "").replace(/\s+/g, "").trim();

      const pickFirstCountUnder = (root) => {
        if (!root) return null;
        const spans = Array.from(root.querySelectorAll("span"));
        for (const s of spans) {
          const tok = cleanToken(s.textContent || "");
          if (isCountToken(tok)) return tok;
        }
        return null;
      };

      // Fallback: collect count-like text nodes in DOM order.
      const collectCountsInOrder = (root) => {
        const out = [];
        const tw = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT,
          null
        );
        while (tw.nextNode()) {
          const tok = cleanToken(tw.currentNode.nodeValue || "");
          if (!tok || !isCountToken(tok)) continue;
          out.push(tok);
          if (out.length >= 10) break;
        }
        return out;
      };

      const anchors = Array.from(document.querySelectorAll("a[href]")).filter(
        (a) => a.getAttribute("href")?.startsWith(prefix)
      );

      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href || seen.has(href)) continue;
        seen.add(href);

        let views = null;
        let likes = null;
        let comments = null;

        // Likes + comments are usually in the overlay <ul><li>…</li><li>…</li></ul>
        const liCounts = Array.from(a.querySelectorAll("ul li"))
          .map((li) => pickFirstCountUnder(li))
          .filter(Boolean);
        if (liCounts.length >= 1) likes = liCounts[0];
        if (liCounts.length >= 2) comments = liCounts[1];

        // Views usually sits next to the "View count icon" SVG.
        const viewSvg =
          a.querySelector('svg[aria-label="View count icon"]') ||
          Array.from(a.querySelectorAll("svg")).find((svg) => {
            const title = svg.querySelector("title")?.textContent || "";
            return /view count/i.test(title);
          });

        if (viewSvg) {
          const svgBox = viewSvg.closest("div");
          const maybeSpan = svgBox?.nextElementSibling;
          const tok = cleanToken(maybeSpan?.textContent || "");
          if (isCountToken(tok)) views = tok;
        }

        // Fallback if DOM structure changes: infer from count ordering.
        if (!views || !likes || !comments) {
          const nums = collectCountsInOrder(a);
          // Common in our saved HTML: [likes, comments, views]
          if (nums.length >= 3) {
            likes ??= nums[0];
            comments ??= nums[1];
            views ??= nums[2];
          } else if (nums.length === 2) {
            likes ??= nums[0];
            comments ??= nums[1];
          } else if (nums.length === 1) {
            // Some grids show only views.
            views ??= nums[0];
          }
        }

        results.push({ href, views, likes, comments });
        if (results.length >= limit) break;
      }

      return results;
    },
    { prefix, limit }
  );
}

async function launchBrowser({ headful, profileDir, args, executablePath, retries = 3 }) {
  const defaultArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  
  const launchOptions = {
    headless: !headful,
    userDataDir: profileDir,
    args: args || defaultArgs,
    ignoreDefaultArgs: false,
    timeout: 60000, // 60 second timeout
  };
  
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  
  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`Retrying browser launch (attempt ${attempt + 1}/${retries}) after ${delay}ms...`);
        await sleep(delay);
      }
      return await puppeteer.launch(launchOptions);
    } catch (error) {
      lastError = error;
      console.warn(`Browser launch attempt ${attempt + 1} failed:`, error.message);
      if (attempt < retries - 1) {
        // Wait a bit before retrying
        await sleep(2000);
      }
    }
  }
  
  throw lastError;
}

async function googleKeepAlive(browser) {
  console.log("Running Google Keep Alive Search");
  const queries = [
    "weather today",
    "news headlines",
    "time in india",
    "currency usd to inr",
    "javascript date now",
    "latest movie releases",
    "local coffee shops",
    "python list comprehension",
    "best programming language 2024",
    "javascript array methods",
    "nearest restaurant",
    "instagram login",
    "youtube trending",
    "current events usa",
    "covid vaccination centers",
    "football match results",
    "nasa latest news",
    "funny cat videos",
    "twitter trending topics",
    "machine learning tutorials",
    "top netflix shows",
    "stackoverflow javascript error",
    "weather in london",
    "nba scores today",
    "world population 2024",
    "grocery stores near me",
  ];
  const q = queries[Math.floor(Math.random() * queries.length)];
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 720 });
  try {
    await tab.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    // tiny scroll to look "human"
    await tab.evaluate(() => window.scrollBy(0, 300)).catch(() => {});
    await sleep(1500);

    // Scroll down then up to look more human (best-effort; ignore failures)
    await tab
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => {});
    await sleep(1200);
    await tab.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(1200);

    await sleep(2500);
  } catch (e) {
    console.warn("Keepalive search failed:", e?.message || e);
  } finally {
    // Scroll down then up to look more human (best-effort; ignore failures)
    await tab
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => {});
    await sleep(1200);
    await tab.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(1200);

    await sleep(2500);
    await tab.close().catch(() => {});
  }
}

async function getUserData({ browser, page, targetUrl, outDir }) {
  // First run: open Instagram headful so user can log in manually; session saved in PROFILE_DIR.
  const profileDir = resolveProfileDir();
  const firstRun = !(await dirHasFiles(profileDir));
  if (firstRun) {
    console.log(
      `First run: opening Instagram for manual login (profile: ${profileDir})`
    );
    console.log(
      "Please log in in the opened browser window. The script will continue once you're logged in."
    );
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    await waitForManualLogin(page);
    console.log("Login detected. Reusing saved session for future runs.");
  } else {
    // Subsequent runs: reuse the saved profile (should already be logged in).
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    const loggedIn = await isInstagramLoggedIn(page);
    if (!loggedIn) {
      console.log(
        "Saved profile is not logged in (session may have expired). Please log in manually in the opened browser window..."
      );
      await waitForManualLogin(page);
      console.log("Login detected. Continuing with capture.");
    } else {
      console.log("Using existing logged-in session from persistent profile.");
    }
  }

    const usernameArray = [
      "thenawazshaikh",
      // "santoshbhagat",
      // "sudhirkushwaha499",
      "jitu.rik",
      // "_krishmenath_07_",
      // "tushar_hasule99",
      // "tejaspunde",
    ];

    //const usernameArray = ["santoshbhagat"];

    const combined = [];
    for (const username of usernameArray) {
      const url = new URL(username + "/reels/", targetUrl).toString();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await sleep(1500);

      const htmlPath = path.join(outDir, `page-${username}.html`);
      const html = await page.content();
      await fs.writeFile(htmlPath, html, "utf8");

      const stats = await extractProfileStats(page, html);
      const links = await extractUserHrefPaths(page, username);
      console.log(links);
      const filteredLinks = [];
      for (const obj of links) {
        if (obj.href.includes("/reel/") && filteredLinks.length <= maxLinksPerUser) {
          filteredLinks.push(obj.href);
        }
      }

      const record = { username, url, ...stats, hrefs: filteredLinks,links };
      combined.push(record);
      const statsPath = path.join(outDir, `profile-${username}.json`);
      await fs.writeFile(statsPath, JSON.stringify(record, null, 2), "utf8");
      const tasks = [];

      for (const link of filteredLinks) {
        const linkUrl = new URL(link, targetUrl).toString();
        // Fire-and-forget: start tab immediately
        const task = await processLinkInTab(browser, linkUrl);
        await sleep(1000);
        tasks.push(task);
      }
      await Promise.allSettled(tasks);

      console.log(`Saved:\n- ${htmlPath}\n- ${statsPath}`);
    }

    const combinedPath = path.join(outDir, "profiles.json");
    await fs.writeFile(combinedPath, JSON.stringify(combined, null, 2), "utf8");
    console.log(`Combined:\n- ${combinedPath}`);
    userDataRetrival=false;
    convertMP4toMP3();
}
async function convertMP4toMP3() {
  console.log("Converting MP4 to MP3 based on Allreel.json");

  const reels = await loadAllReels();
  let changed = false;

  for (const entry of reels) {
    if (!entry.downloaded) continue;
    if (entry.isConverted) continue;
    if (!entry.filePath || !entry.filePath.endsWith(".mp4")) continue;

    const inputPath = entry.filePath.replace(/\.crdownload$/i, "");
  
    const outputPath =
      entry.mp3FilePath ||
      inputPath.replace(/\.mp4$/i, ".mp3");

    try {
      console.log("Running ffmpeg for:", inputPath, "->", outputPath);
      await execAsync(
        `ffmpeg -y -i "${inputPath}" -vn -acodec libmp3lame -q:a 2 "${outputPath}"`
      );

      entry.mp3FilePath = outputPath;
      entry.isConverted = true;
      changed = true;
      console.log("MP3 created:", outputPath);
    } catch (err) {
      console.error("ffmpeg conversion failed for", inputPath, ":", err.message);
    }
  }

  if (changed) {
    await saveAllReels(reels);
    console.log("Allreel.json updated with MP3 paths.");
  } else {
    console.log("No MP4 entries required conversion.");
  }
}

async function runScheduled() {
  const targetUrl = getArgUrl();
  const profileDir = resolveProfileDir();
  await fs.mkdir(profileDir, { recursive: true });
  const firstRun = !(await dirHasFiles(profileDir));
  const headful = process.env.HEADFUL === "1" || firstRun;

  const browser = await launchBrowser({ headful, profileDir });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const keepAliveEveryMsRaw = Number(
    process.env.KEEPALIVE_EVERY_MS || 15 * MINUTE_MS
  );
  const runEveryMsRaw = Number(process.env.RUN_EVERY_MS || HOUR_MS);
  const keepAliveEveryMs = Number.isFinite(keepAliveEveryMsRaw)
    ? keepAliveEveryMsRaw
    : 15 * MINUTE_MS;
  const runEveryMs = Number.isFinite(runEveryMsRaw) ? runEveryMsRaw : HOUR_MS;

  const close = async () => {
    await browser.close().catch(() => {});
  };
  process.on("SIGINT", async () => {
    console.log("SIGINT received, closing browser...");
    await close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, closing browser...");
    await close();
    process.exit(0);
  });

  while (true) {
    const runStartedAt = Date.now();
    const outDir = path.resolve(process.cwd(), "output", tsDirName());
    await fs.mkdir(outDir, { recursive: true });

    console.log(
      `\n[RUN] ${new Date().toISOString()} - capturing profiles (next run in ~${Math.round(
        runEveryMs / MINUTE_MS
      )} min)`
    );

    try {
      await getUserData({ browser, page, targetUrl, outDir });
    } catch (e) {
      console.error("[RUN] capture failed:", e?.message || e);
    }

    const nextRunAt = runStartedAt + runEveryMs;
    while (Date.now() < nextRunAt) {
      const remaining = nextRunAt - Date.now();
      const wait = Math.min(keepAliveEveryMs, remaining);
      await sleep(wait);
      if (Date.now() < nextRunAt) {
        console.log(
          `[KEEPALIVE] ${new Date().toISOString()} - google search (every ~${Math.round(
            keepAliveEveryMs / MINUTE_MS
          )} min)`
        );
        await googleKeepAlive(browser);
      }
    }
  }
}

async function processLinkInTab(browser, linkUrl) {
  // Skip if this reel link was already logged in Allreel.json
  const existingList = await loadAllReels();
  if (existingList.some((e) => e.linkUrl === linkUrl && e.downloaded)) {
    console.log("Skipping already processed reel:", linkUrl);
    return;
  }

  // Ensure an entry exists before attempting download
  await upsertReelEntry(linkUrl, (entry) => {
    entry.downloaded = false;
  });

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 720 });

  try {
    console.log("Opened tab for:", linkUrl);

    await tab.goto("https://fastvideosave.net/", {
      waitUntil: "domcontentloaded",
    });

    await tab.waitForSelector('input[name="url"]', { timeout: 30_000 });
    await tab.click('input[name="url"]', { clickCount: 3 });
    await tab.type('input[name="url"]', linkUrl, { delay: 20 });
    await tab.click('button[type="submit"]');

    // Each tab waits on its own timeline
    console.log("Tab waiting 10s:", linkUrl);
    // await tab.waitForTimeout(60_000);
    await sleep(10_000); // <-- compatible with all Puppeteer versions

    const clicked = await tab.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Download Video")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (clicked) {
      await sleep(3000);

      // Try to detect the latest file in the Downloads folder
      const latest = await getLatestDownloadedFile();
      if (latest) {
        console.log(
          "Latest downloaded file for",
          linkUrl,
          "=>",
          latest.fileName,
          latest.filePath
        );
        await upsertReelEntry(linkUrl, (entry) => {
          entry.downloaded = true;
          entry.filePath = latest.filePath;
        });
      } else {
        console.log("No new file detected in Downloads for:", linkUrl);
        await upsertReelEntry(linkUrl, (entry) => {
          entry.downloaded = true;
        });
      }

      // await tab.close().catch(() => {});
      console.log("Download clicked:", linkUrl);
    } else {
      console.warn("Download button not found:", linkUrl);
    }
  } catch (e) {
    console.error("Tab failed:", linkUrl, e.message);
  } finally {
    await tab.close().catch(() => {});
  }
  // Do not close immediately if downloads are needed
  // await tab.close().catch(() => {});
}


async function runGoogleKeepAlive() {
  console.log("Running Google Keep Alive");
  // const browser = await launchBrowser({ headful: true, profileDir: resolveProfileDir() });
  await googleKeepAlive(browser);
  // await browser.close();
}

async function getInstagramData() {
  console.log("Getting Instagram Data");
  if (!browser) {
    console.error("Browser not initialized");
    return;
  }
  
  const targetUrl = getArgUrl();
  const outDir = path.resolve(process.cwd(), "output", tsDirName());
  await fs.mkdir(outDir, { recursive: true });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    // await waitForInstagramLoggedIn(page);
    await getUserData({ browser, page, targetUrl, outDir });
  } finally {
    await page.close().catch(() => {});
  }
}


async function checkChromeProcesses(profileDir) {
  try {
    // Check for Chrome processes on macOS
    const { stdout } = await execAsync(
      `ps aux | grep -i "chrome.*${profileDir}" | grep -v grep || true`
    );
    if (stdout.trim()) {
      console.warn("⚠️  Warning: Chrome processes detected using this profile:");
      console.warn(stdout.trim());
      return true;
    }
  } catch (error) {
    // Ignore errors (might not have ps command or different OS)
  }
  return false;
}

let browser=null;
async function main() {
  try {
    const profileDir = resolveProfileDir();
    await fs.mkdir(profileDir, { recursive: true });
    
    console.log(`Launching browser with profile: ${profileDir}`);
    
    // Check for existing Chrome processes
    const hasChromeRunning = await checkChromeProcesses(profileDir);
    if (hasChromeRunning) {
      console.warn("⚠️  Chrome may already be running with this profile.");
      console.warn("   Please close Chrome and try again, or wait 5 seconds...");
      await sleep(5000);
    }
    
    browser = await launchBrowser({ 
      headful: true, 
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      profileDir,
      retries: 3
    });
    
    console.log("✅ Browser launched successfully");
    
    // Verify browser is working
    const testPage = await browser.newPage();
    await testPage.close();
    console.log("✅ Browser connection verified");
  } catch (error) {
    console.error("❌ Failed to launch browser after retries:", error.message);
    console.error("\n🔧 Troubleshooting steps:");
    console.error("1. Close ALL Chrome/Chromium instances completely");
    console.error("2. Wait 5-10 seconds for processes to fully terminate");
    console.error("3. Try setting PROFILE_DIR to a different directory:");
    console.error(`   PROFILE_DIR=./chrome-profile-2 node src/index.js`);
    console.error(`4. Current profile directory: ${resolveProfileDir()}`);
    console.error("5. On macOS, you can kill Chrome with: killall 'Google Chrome'");
    process.exit(1);
  }

  console.log("Starting main loop");

  setInterval(async () => {
    try {
      // Check if browser is still connected
      if (!browser || !browser.isConnected()) {
        console.error("Browser disconnected, exiting...");
        process.exit(1);
      }
      
      console.log("Running loop userDataCount", userDataCount, "googleKeepAliveCount", googleKeepAliveCount, "userDataRetrival", userDataRetrival);
      if(!userDataRetrival){
        userDataCount++;
        googleKeepAliveCount++;
        if (userDataCount >= targetUserDataCount) {
          userDataCount = 0;
          userDataRetrival=true;
          await getInstagramData();
        } else if (googleKeepAliveCount >= targetGoogleKeepAliveCount) {
          googleKeepAliveCount = 0;
          await runGoogleKeepAlive();
        }
      }
    } catch (error) {
      console.error("Error in main loop:", error.message);
    }
  }, 1 * 60 * 1000);
  
  await getInstagramData();
  // convertMP4toMP3();
}

const currentMinute = new Date().getMinutes();
console.log("Current minute of the system:", currentMinute);

let userDataCount=currentMinute;
let googleKeepAliveCount=16;

console.log("userDataCount", userDataCount, "googleKeepAliveCount", googleKeepAliveCount);

let targetUserDataCount=60;
let targetGoogleKeepAliveCount=15;

let userDataRetrival=false

let maxLinksPerUser=10;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
