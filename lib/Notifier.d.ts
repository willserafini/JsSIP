import {EventEmitter} from 'events'
import {SUBSCRIBE, NOTIFY} from './Constants'
import * as Utils from './Utils'

export class Notifier extends EventEmitter {
  setActiveState(): void;
  sendNotify(body?: string): void; 
  sendFinalNotify(body?: string, reason?: string): void; 
  get state(): string;
}