# Tab Auto Rename (Firefox MV3)

Tab Auto Rename is a Firefox add-on that renames tab titles on selected sites.

## Features

- Site rules based on Firefox match patterns.
- Two title modes:
  - static text
  - template with placeholders
- Placeholder capabilities:
  - Host and root domain: `{host}`, `{domain}`
  - Domain indexing from right to left: `{domain-N}`, `{domain-NtoM}`
  - Path indexing from left to right: `{path}`, `{path-N}`, `{path-NtoM}`
  - Additional values: `{port}`, `{origname}`
- Rule conflict resolution: most specific match pattern wins.
- Runtime host permission requests (only for the sites you choose).
- Popup for full rule management on current tab matching rules.
- Apply flow in popup that requests missing site access and closes the popup.
- Automatic host-permission cleanup when a rule is deleted and no rules use that site pattern anymore.

## Template examples

Copyable base template:

```text
{origname} | {domain-1to2} | {path-1to2}
```

For URL `https://cucm1.winncom.ua:8443/ccmadmin/example`:

- `{host}` -> `cucm1.winncom.ua`
- `{domain}` -> `winncom.ua`
- `{domain-1}` -> `ua`
- `{domain-1to2}` -> `winncom.ua`
- `{domain-1to3}` -> `cucm1.winncom.ua`
- `{port}` -> `8443`
- `{path-1}` -> `ccmadmin`
- `{path-2}` -> `example`
- `{path-1to2}` -> `ccmadmin/example`

## Firefox target

- Manifest V3
- Firefox 140+

## Development

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Typecheck

```bash
npm run typecheck
```

### Web-ext lint

```bash
npm run webext:lint
```

### Run in Firefox

```bash
npm run webext:run
```

## Permission model

The add-on uses:

- `storage` for local settings and rules.
- `tabs` for popup tab context.
- `scripting` for dynamic content script registration.
- `optional_host_permissions` with runtime user approval per site pattern.

No remote code is loaded. No telemetry or data transmission is implemented.

## Build output

The built extension is generated in `dist/`.

## Toolbar icon

The action button is installed into the extensions panel (`default_area: "menupanel"`), not directly into the toolbar.
Pin it from there: right-click the add-on -> "Pin to Toolbar".

- Firefox: extensions (puzzle) button in the toolbar.
- Zen 1.17+: the site panel button at the left edge of the URL bar, extensions section.

### If the icon is still hidden or cannot be pinned (Zen/Firefox forks)

Builds before this change used `default_area: "navbar"`. Firefox remembers a button's placement per add-on ID,
even after the add-on is removed, so a profile that had such a build keeps the button in the nav-bar.
Zen does not always render nav-bar extension buttons, and buttons placed there are not listed in the extensions panel,
so there is nothing to pin. To move the button back to the panel:

1. Set `devtools.chrome.enabled` to `true` in `about:config`.
2. Open the Browser Console (`Ctrl+Shift+J`) and run:

   ```js
  CustomizableUI.addWidgetToArea("tab-autorename_calladot_dev-browser-action", CustomizableUI.AREA_ADDONS)
   ```

Fallbacks that do not need the icon:

- Open the popup from the add-on icon to manage matching rules and apply site access.

## Publish preparation

See `docs/amo-submission.md`.
