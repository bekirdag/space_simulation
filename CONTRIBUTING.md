# Contributing To CosmosMap

Contributions are welcome. CosmosMap is meant to be educational, visually
clear, and honest about the difference between simulation, mapped data, and
visual approximations.

## Good Contribution Areas

- Data fixes for names, distances, sources, or object metadata.
- Performance improvements for WebGPU rendering, culling, and catalog loading.
- Better educational UI for explaining what is real data and what is an
  approximation.
- More complete tests and browser smoke checks.
- Accessibility and mobile layout improvements.
- Documentation improvements for install, data refresh, and simulation limits.

## Before Opening A Pull Request

1. Keep changes focused.
2. Avoid mixing generated data refreshes with unrelated UI or physics changes.
3. Run validation:

```sh
npm install
npm test
npm run build
```

4. For shader or rendering changes, test in a WebGPU-capable browser.
5. Update the README or in-app Limits page when changing assumptions, data
   sources, object counts, or culling behavior.

## Reporting Issues

Please include:

- Browser and operating system.
- Steps to reproduce.
- What you expected to happen.
- What actually happened.
- Screenshots or console errors if rendering is involved.

Open issues at:

https://github.com/bekirdag/space_simulation/issues

## Data And Attribution

When adding or refreshing datasets, include the source URL, retrieval date, and
any processing assumptions. Prefer checked-in metadata files near generated
runtime assets when practical.

## License

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
