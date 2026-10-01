import { describeTurnBasedConformance } from '@playhall/game-testkit/vitest'
import { manifest, server } from '../src/index.js'

describeTurnBasedConformance({ manifest, server })
