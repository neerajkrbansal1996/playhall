/** Conventional Commits — enforced by the commit-msg hook and by CI (PER-6). */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'repo',
        'ci',
        'web',
        'realtime',
        'shared',
        'game-sdk',
        'platform-core',
        'netcode',
        'game-testkit',
        'ui',
        'games',
        'docs',
        'deps',
      ],
    ],
    'subject-case': [0],
  },
}
