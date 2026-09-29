// Anchor for `tsconfig.resolve.json`. TypeScript refuses to load a tsconfig whose `files`
// list is empty (TS18002) or whose `include` matches nothing (TS18003), and dependency-cruiser
// loads that tsconfig only to read `paths`. This file exists so the config is loadable; it
// declares nothing and is never compiled into anything.
export {}
