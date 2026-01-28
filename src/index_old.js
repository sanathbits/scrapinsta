import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";
import dotenv from "dotenv";

dotenv.config();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (fromHtml.posts != null || fromHtml.followers != null || fromHtml.following != null) {
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
    console.warn(`Warning: screenshot failed for ${filePath}: ${e?.message || e}`);
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
      if (href.includes("/challenge") || href.includes("/two_factor")) return true;

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
  await page.waitForFunction(() => {
    const href = location.href;
    if (href.includes("/challenge") || href.includes("/two_factor")) return true;

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
  }, { timeout: 60_000 });
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
  await clickButtonByExactText(page, "Only allow essential cookies", 1500).catch(
    () => {}
  );
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
    .waitForFunction(() => {
      const b = document.querySelector('button[type="submit"]');
      return !!b && !(b instanceof HTMLButtonElement && b.disabled);
    }, { timeout: 10_000 })
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
    await safeScreenshot(page, path.join(outDir, "login-03-after-submit.png"), true);
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

async function extractUserHrefPaths(page, username, limit = 200) {
  const prefix = `/${username}/`;
  const hrefs = await page
    .evaluate(
      ({ pfx, lim }) => {
        const out = [];
        const seen = new Set();
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const h = a.getAttribute("href") || "";
          if (!h.startsWith(pfx)) continue;
          if (seen.has(h)) continue;
          seen.add(h);
          out.push(h);
          if (out.length >= lim) break;
        }
        return out;
      },
      { pfx: prefix, lim: limit }
    )
    .catch(() => []);

  return { prefix, hrefs };
}

async function launchBrowser({ headful, profileDir }) {
  return await puppeteer.launch({
    headless: !headful,
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

async function main() {
  const targetUrl = getArgUrl();
  const keepOpen = process.env.KEEP_OPEN === "1";

  const outDir = path.resolve(process.cwd(), "output", tsDirName());

  const extensionPath = path.resolve("./extensions/turbo-downloader");
  await fs.mkdir(outDir, { recursive: true });

  const profileDir = resolveProfileDir();
  await fs.mkdir(profileDir, { recursive: true });
  const firstRun = !(await dirHasFiles(profileDir));
  const headful = process.env.HEADFUL === "1" || firstRun;

  let browser = await launchBrowser({ headful, profileDir, args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],});
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  try {
    // First run: open Instagram headful so user can log in manually; session saved in PROFILE_DIR.
    if (firstRun) {
      console.log(`First run: opening Instagram for manual login (profile: ${profileDir})`);
      console.log("Please log in in the opened browser window. The script will continue once you're logged in.");
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await waitForManualLogin(page);
      console.log("Login detected. Reusing saved session for future runs.");
    } else {
      // Subsequent runs: reuse the saved profile (should already be logged in).
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      const loggedIn = await isInstagramLoggedIn(page);
      if (!loggedIn) {
        console.log("Saved profile is not logged in (session may have expired). Opening headful for manual login...");
        if (!headful) {
          // Relaunch headful with same profile.
          await browser.close().catch(() => {});
          browser = await launchBrowser({ headful: true, profileDir });
          page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 720 });
          await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
        }
        await waitForManualLogin(page);
        console.log("Login detected. Continuing with capture.");
      } else {
        console.log("Using existing logged-in session from persistent profile.");
      }
    }

    //const usernameArray = ["sharmasagarr.01","santoshbhagat","sudhirkushwaha499","jitu.rik","_krishmenath_07_","tushar_hasule99","tejaspunde"];

    const usernameArray = ["santoshbhagat"];

    const combined = [];
    for (const username of usernameArray) {
    const url = new URL(username, targetUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    // const screenshotPath = path.join(outDir, `screenshot-${username}.png`);
    // await safeScreenshot(page, screenshotPath, true);

    const htmlPath = path.join(outDir, `page-${username}.html`);
    const html = await page.content();
    // await fs.writeFile(htmlPath, html, "utf8");

    const stats = await extractProfileStats(page, html);
    const links = await extractUserHrefPaths(page, username);
    const filteredLinks = []
    for (const link of links.hrefs) {
      if (link.includes("/reel/")) {
        filteredLinks.push(link);
      }
    }
    const record = { username, url, ...stats, hrefs: filteredLinks };
    combined.push(record);
    const statsPath = path.join(outDir, `profile-${username}.json`);
    await fs.writeFile(
      statsPath,
      JSON.stringify(record, null, 2),
      "utf8"
    );

    

    // const cssPath = path.join(outDir, "styles.css");
    // const css = await extractCssText(page);
    // await fs.writeFile(cssPath, css || "", "utf8");

    // const metaPath = path.join(outDir, "meta.json");
    // await fs.writeFile(
    //   metaPath,
    //   JSON.stringify(
    //     {
    //       capturedAt: new Date().toISOString(),
    //       targetUrl,
    //       notes:
    //         "CSS is best-effort (inline + same-origin). Cross-origin stylesheet rules may be omitted due to browser security.",
    //     },
    //     null,
    //     2
    //   ),
    //   "utf8"
    // );

    console.log(`Saved:\n- ${htmlPath}\n- ${statsPath}`);
    }

    const combinedPath = path.join(outDir, "profiles.json");
    await fs.writeFile(combinedPath, JSON.stringify(combined, null, 2), "utf8");
    console.log(`Combined:\n- ${combinedPath}`);
  } finally {
    if (!keepOpen) await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

