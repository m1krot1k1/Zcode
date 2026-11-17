# ui-settings-stage4

Reactive settings groups for Increments 4.1–4.6.

- Owner of values: `settingService` (`~/.zcode/v2/setting.json`). This module never caches values;
  it renders `AppSettings` and writes patches through `updateSharedSettings`.
- Sections are merged as whole nested objects, because `settingService` merges at the
  `AppSettings` level. `mergeStage4Section` keeps hidden fields such as `modelOverride`.
- Every toggle contributes to `projectStage4SettingsToSessionPreferences` /
  `projectStage4SettingsToCliConfig`, so a UI change reaches the runtime.
- Search matches on localized label, description and impact hints.
