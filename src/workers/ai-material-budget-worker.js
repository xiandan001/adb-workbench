import { measureDraftBudget } from '../shared/aiMaterialBudget.js';
self.onmessage = event => { self.postMessage(measureDraftBudget(event.data)); };
