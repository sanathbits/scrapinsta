# Instagram Auto Capture (Puppeteer)

This script:
- Logs into Instagram using credentials from a local `.env`
- Navigates to a target URL
- Saves **full-page screenshot** + **HTML** + **best-effort CSS dump** to `output/<timestamp>/`

## Setup

1) Install dependencies:

```bash
npm install
```

2) Create your `.env`:

- Copy `example.env` to `.env`
- Fill in:
  - `INSTAGRAM_USERNAME`
  - `INSTAGRAM_PASSWORD`

> Note: `.env` is ignored by git (see `.gitignore`).

## Run

Capture a specific URL:

```bash
npm start -- "https://www.instagram.com/instagram/"
```

Or set `TARGET_URL` in `.env` and run:

```bash
npm start
```

If Instagram shows **2FA / CAPTCHA / checkpoint**, run in headful mode so you can complete it manually:

```bash
HEADFUL=1 npm start -- "https://www.instagram.com/instagram/"
```

If you want to keep the browser open while debugging:

```bash
HEADFUL=1 KEEP_OPEN=1 npm start -- "https://www.instagram.com/instagram/"
```

## Output

Files are written to:
- `output/<timestamp>/page.png`
- `output/<timestamp>/page.html`
- `output/<timestamp>/styles.css`
- `output/<timestamp>/meta.json`

## Notes / Limitations

- This is **best-effort automation**. Instagram frequently changes UI and may block automation.
- The CSS export is **not a perfect “save complete page”**:
  - It includes inline `<style>` tags
  - It includes same-origin stylesheet rules
  - It may omit cross-origin stylesheet rules due to browser security (CORS)
- Make sure your usage complies with Instagram’s Terms of Service and applicable laws.

