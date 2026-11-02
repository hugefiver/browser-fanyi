import browser from '../shared/browser';
import { BackgroundController } from './controller';

// Register listeners on every service-worker activation; grants remain in memory.
new BackgroundController(browser).install();
