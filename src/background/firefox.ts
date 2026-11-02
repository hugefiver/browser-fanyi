import browser from '../shared/browser';
import { BackgroundController } from './controller';

// Event-page reloads register fresh listeners and require fresh user grants.
new BackgroundController(browser).install();
