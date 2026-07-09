import { EventEmitter } from "node:events";

/**
 * A thin typed wrapper over Node's EventEmitter. `E` maps event names to their
 * listener signatures (an interface is fine — no index signature required).
 */
export class TypedEmitter<E> extends EventEmitter {
  override on<K extends keyof E & string>(
    event: K,
    listener: E[K] extends (...args: any[]) => void ? E[K] : never
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
  override emit<K extends keyof E & string>(
    event: K,
    ...args: E[K] extends (...args: infer A) => void ? A : never
  ): boolean {
    return super.emit(event, ...args);
  }
}
