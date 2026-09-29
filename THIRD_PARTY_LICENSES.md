# Third-party code licences

Every third-party code dependency that ships in a build, or that materially shapes the
product, is logged here. **No GPL/AGPL UI libraries or piece sets unless we open-source
the project.** Add a row in the same PR that adds the dependency.

Transitive dependencies are not listed individually; the licence audit runs over the
full tree in CI (M0.2) and fails on any copyleft licence in a shipped bundle.

## Runtime

| Package                  | Version | Licence    | Used by       | Notes                                    |
| ------------------------ | ------- | ---------- | ------------- | ---------------------------------------- |
| next                     | ^15     | MIT        | apps/web      | App Router.                              |
| react, react-dom         | ^19     | MIT        | apps/web, ui  |                                          |
| tailwindcss              | ^4      | MIT        | apps/web      |                                          |
| tailwindcss-animate      | ^1      | MIT        | apps/web      |                                          |
| class-variance-authority | ^0.7    | Apache-2.0 | apps/web, ui  | shadcn/ui variant helper.                |
| clsx                     | ^2      | MIT        | apps/web, ui  |                                          |
| tailwind-merge           | ^2      | MIT        | apps/web, ui  |                                          |
| lucide-react             | ^0.471  | ISC        | apps/web      | Icon set.                                |
| zod                      | ^3      | MIT        | apps/realtime | Schema for every message and HTTP input. |

## Vendored source (not an npm dependency)

| Source    | Licence | Where                        | Notes                                                        |
| --------- | ------- | ---------------------------- | ------------------------------------------------------------ |
| shadcn/ui | MIT     | `apps/web/src/components/ui` | Components are copied into the repo by design, not imported. |

## Tooling (dev only, not shipped)

TypeScript (Apache-2.0), ESLint (MIT), typescript-eslint (MIT/BSD-2-Clause), Prettier
(MIT), commitlint (MIT), husky (MIT), tsx (MIT), pnpm (MIT).
