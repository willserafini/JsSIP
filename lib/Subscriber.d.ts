import {EventEmitter} from 'events'
import {SUBSCRIBE, NOTIFY} from './Constants'
import * as Utils from './Utils'

export class Subscriber extends EventEmitter {
  subscribe(body?: string): void;
  unsubscribe(body?: string): void;
  get state(): string;
}