import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const YAD2_URL =
  "https://www.yad2.co.il/realestate/rent/tel-aviv-area?minRooms=2&maxRooms=4&maxPrice=16000&multiNeighborhood=1521%2C848%2C1520"

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
}

type PageKind = "captcha" | "bot_challenge" | "access_denied" | "normal_results" | "unknown"

const CAPTCHA_MARKERS = ["captcha", "hcaptcha", "recaptcha", "perfdrive", "shieldsquare", "radware"]
const CHALLENGE_MARKERS = [
  "just a moment",
  "cf-chl",
  "challenge-platform",
  "_incapsula_resource",
  "px-captcha",
  "are you a robot",
  "checking your browser",
  "bot manager",
]
const DENIED_MARKERS = ["access denied", "request blocked", "forbidden", "you have been blocked"]
const RESULTS_MARKERS = ["__next_data__", "feed_item", "feeditem", "realestate", "יד2"]

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? match[1].replace(/\s+/g, " ").trim() || null : null
}

function findMarkers(haystack: string, markers: string[]) {
  return markers.filter((marker) => haystack.includes(marker))
}

function classify(status: number, html: string, finalUrl: string) {
  const lower = html.toLowerCase()
  const lowerUrl = finalUrl.toLowerCase()

  const captcha = findMarkers(lower, CAPTCHA_MARKERS)
  const challenge = findMarkers(lower, CHALLENGE_MARKERS)
  const denied = findMarkers(lower, DENIED_MARKERS)
  const results = findMarkers(lower, RESULTS_MARKERS)

  let kind: PageKind = "unknown"
  if (captcha.length > 0 || lowerUrl.includes("perfdrive") || lowerUrl.includes("captcha")) {
    kind = "captcha"
  } else if (challenge.length > 0) {
    kind = "bot_challenge"
  } else if (status === 401 || status === 403 || denied.length > 0) {
    kind = "access_denied"
  } else if (status >= 200 && status < 300 && results.length >= 2 && html.length > 20000) {
    kind = "normal_results"
  }

  return {
    kind,
    is_captcha: kind === "captcha",
    is_bot_challenge: kind === "bot_challenge",
    is_access_denied: kind === "access_denied",
    is_normal_results_page: kind === "normal_results",
    matched_markers: { captcha, challenge, denied, results },
  }
}

export async function GET() {
  const startedAt = Date.now()

  try {
    const response = await fetch(YAD2_URL, {
      method: "GET",
      headers: BROWSER_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    })

    const html = await response.text()
    const detection = classify(response.status, html, response.url)

    return NextResponse.json(
      {
        success: detection.kind === "normal_results",
        requested_url: YAD2_URL,
        yad2_status: response.status,
        final_url: response.url,
        redirected: response.redirected,
        content_type: response.headers.get("content-type"),
        html_length: html.length,
        page_title: extractTitle(html),
        detection,
        duration_ms: Date.now() - startedAt,
        checked_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError"
    return NextResponse.json(
      {
        success: false,
        requested_url: YAD2_URL,
        error: isTimeout ? "Request to Yad2 timed out after 20s" : "Request to Yad2 failed",
        error_detail: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startedAt,
        checked_at: new Date().toISOString(),
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    )
  }
}
