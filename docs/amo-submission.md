# AMO submission checklist

## Policy alignment

- No obfuscated code.
- No remote code execution.
- Only necessary permissions are requested.
- Runtime host access is requested explicitly by user action.
- Add-on behavior matches listing description.

## Data practices

- No personal data collection.
- No telemetry.
- No data transmission to external services.
- All processing is local in the browser.

## Source review readiness

- Source is plain TypeScript and static HTML/CSS.
- Build is reproducible with:

```bash
npm install
npm run build
```

- Reviewer test flow:
  1. Open options page.
  2. Add a rule with a valid match pattern.
  3. Grant access for that pattern.
  4. Open a matching site and verify tab title rename.
  5. Revoke permission and verify rename no longer applies.

## Notes

- Add-on ID is set in `manifest.json` under `browser_specific_settings.gecko.id`.
- Minimum Firefox version is set to 140.
