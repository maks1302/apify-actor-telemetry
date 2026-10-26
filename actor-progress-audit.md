# Actor failure progress audit

Inspected local source on 2026-10-26. Scope: 45 included configured Actors (43 JavaScript, 2 Python). Excludes `email-verifyier-actor`, `google-maps-scraper-local-business-data`, `website-crawler`, `apify-ui-ux-best-practices`, and `trus`.

## Finding

**No, a complete four-counter snapshot is not guaranteed across all Actors and all failure paths.** Many JavaScript business failures already include `processed`, `succeeded`, `failed`, and `saved`, but some initialization, import, abort, exit, and top-level failures omit progress. Python snapshots are incomplete. Counters use Actor-specific units, so the SDK must not infer them or increment failed work for each retry.

Concrete gaps:

- `twitter-search`: [_progress](/Users/maksimdzura/projects/apify-actors/twitter-search/src/main.py:363) returns only `saved`.
- `twitter-community-search`: [storage failure](/Users/maksimdzura/projects/apify-actors/twitter-community-search/src/main.py:209) supplies `saved` and `processed`; [community failure](/Users/maksimdzura/projects/apify-actors/twitter-community-search/src/main.py:296) also supplies only two counters. Top-level captures omit progress.
- `instagram-scraper`: [initialization failure](/Users/maksimdzura/projects/apify-actors/instagram-scraper/src/run.js:9) captures without progress, before the run counter object is created.
- `facebook-profile-scraper`: [initialization failure](/Users/maksimdzura/projects/apify-actors/facebook-profile-scraper/src/actor.js:19) captures without progress; its four-counter state is created after initialization.
- `airbnb-search-scraper`: [startup/import failure](/Users/maksimdzura/projects/apify-actors/airbnb-search-scraper/src/main.js:15) captures without progress.

## SDK-first change

Local SDK version 0.2.0 adds `setProgress(countersOrCallback)` and `contexts.progress_completeness`. Captures synchronously snapshot the registered live source, superseding stale origin progress; explicit capture progress takes precedence. Missing and invalid counters are identified explicitly instead of fabricating zero values. Real pre-work zeros must be initialized by the Actor.

**The SDK changes do not yet upgrade Actor dependency pins or wire their counters.** The all-Actor rollout must register the run state before failure-prone initialization/imports; maintain each Actor’s existing counter units; include lifecycle failures; and add equivalent four-counter handling in Python. The five exclusions remain untouched. SDK source, package, and type checks cover its new contracts; they are not evidence that every Actor has been migrated.

## Per-Actor source inventory

The inventory below records direct `.captureException` calls and whether the second argument is an object literal with a `progress` field. This is a source-screening heuristic, not a runtime coverage score: a context variable, an inherited annotation, `exitActor`, or a wrapper can also supply progress. Entries with no omitted inline fields are not certified complete. This inventory is intended to guide targeted rollout tests.

- **Tripadvisor-Reviews-Scraper** — 3 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/Tripadvisor-Reviews-Scraper/src/run.js:30).
- **YT-channel-scraper** — 3 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/YT-channel-scraper/src/requests.js:77).
- **YT-comments-scraper** — 3 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/YT-comments-scraper/src/run.js:16).
- **YT-search-apify** — 1 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/YT-search-apify/src/actorRun.js:256).
- **YT-video-download** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/YT-video-download/src/downloads.js:80).
- **YT-video-transcript** — 5 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/YT-video-transcript/src/actor.js:179).
- **airbnb-search-scraper** — 4 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/airbnb-search-scraper/src/main.js:15).
- **booking-hotels-scraper** — 3 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/booking-hotels-scraper/src/run-actor.js:77).
- **booking-reviews-scraper** — 4 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/booking-reviews-scraper/src/run-actor.js:88).
- **facebook-comments-scraper** — 6 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/facebook-comments-scraper/src/main.js:10).
- **facebook-groups-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/facebook-groups-scraper/src/run.js:21).
- **facebook-pages-scraper** — 8 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/facebook-pages-scraper/src/main.js:11).
- **facebook-posts-scraper** — 3 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/facebook-posts-scraper/src/actor.js:19).
- **facebook-profile-scraper** — 3 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/facebook-profile-scraper/src/actor.js:19).
- **google-map-reviews-scraper-apify** — 3 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/google-map-reviews-scraper-apify/src/index.js:11).
- **google-map-scrapper-apify** — 4 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/google-map-scrapper-apify/src/run-actor.js:190).
- **google-maps-photo-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/google-maps-photo-scraper/src/actor-run.js:97).
- **google-search** — 0 direct capture calls; 0 without an inline progress field. Uses helpers/wrappers; inspect their supplied context during adoption.
- **instagram-hashtag-scraper** — 4 direct capture calls; 4 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/instagram-hashtag-scraper/src/main.js:16).
- **instagram-posts-scraper** — 5 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/instagram-posts-scraper/src/main.js:13).
- **instagram-scraper** — 5 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/instagram-scraper/src/run.js:9).
- **linkedin-company-posts-scraper** — 4 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/linkedin-company-posts-scraper/src/main.js:15).
- **linkedin-jobs-scraper** — 0 direct capture calls; 0 without an inline progress field. Uses helpers/wrappers; inspect their supplied context during adoption.
- **linkedin-post-comments-scraper** — 7 direct capture calls; 4 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/linkedin-post-comments-scraper/src/main.js:11).
- **linkedin-post-reactions-scraper** — 8 direct capture calls; 4 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/linkedin-post-reactions-scraper/src/linkedin-api.js:321).
- **linkedin-post-reposters-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/linkedin-post-reposters-scraper/src/main.js:35).
- **linkedin-post-search-scraper** — 2 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/linkedin-post-search-scraper/src/main.js:13).
- **linkedin-profile-posts-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/linkedin-profile-posts-scraper/src/actor-run.js:37).
- **linkedin-profile-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/linkedin-profile-scraper/src/actor-run.js:40).
- **tiktok-comments-scraper** — 5 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/tiktok-comments-scraper/src/run.js:10).
- **tiktok-data-scraper** — 7 direct capture calls; 3 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/tiktok-data-scraper/src/main.js:10).
- **tiktok-followers-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/tiktok-followers-scraper/src/lib/tiktokApi.js:100).
- **tiktok-hashtag-scraper** — 5 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/tiktok-hashtag-scraper/src/lib/tiktokApi.js:123).
- **tiktok-profile-scraper** — 4 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/tiktok-profile-scraper/src/main.js:17).
- **tiktok-video-downloader** — 5 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/tiktok-video-downloader/src/downloader.js:539).
- **trustpilot-reviews-scraper** — 2 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/trustpilot-reviews-scraper/src/main.js:14).
- **twitter-community-search** — Python implementation; partial counter schema described above. Requires equivalent Actor-level changes rather than the JS SDK.
- **twitter-followers-scraper** — 2 direct capture calls; 0 without an inline progress field. [Capture source](/Users/maksimdzura/projects/apify-actors/twitter-followers-scraper/src/run.js:35).
- **twitter-profile-scraper** — 5 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/twitter-profile-scraper/src/main.js:15).
- **twitter-replies-retweets-scraper** — 6 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/twitter-replies-retweets-scraper/src/lib/run.js:26).
- **twitter-search** — Python implementation; partial counter schema described above. Requires equivalent Actor-level changes rather than the JS SDK.
- **yelp-reviews-scraper** — 5 direct capture calls; 4 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/yelp-reviews-scraper/src/main.js:11).
- **yelp-scraper** — 3 direct capture calls; 2 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/yelp-scraper/src/actor.js:35).
- **zillow-property-details** — 2 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/zillow-property-details/src/actor.js:12).
- **zillow-search** — 4 direct capture calls; 1 without an inline progress field. [First review point](/Users/maksimdzura/projects/apify-actors/zillow-search/src/run.js:15).

## Acceptance criteria for rollout

- Every included Actor reports four real numeric counters at failure time, including before work begins and during lifecycle failures.
- Counts remain in the Actor’s existing units, with no changes to datasets, billing, pagination, retries, or termination behavior.
- Recovered retries do not increment terminal failure counts or create duplicate issues merely because response annotation is present.
- Tests assert actual emitted telemetry, including progress on startup, terminal API, parsing/validation, storage, partial-output, and lifecycle failures where applicable.
- Response bodies and progress from independent requests stay isolated, and a later network failure does not carry a prior HTTP response.
