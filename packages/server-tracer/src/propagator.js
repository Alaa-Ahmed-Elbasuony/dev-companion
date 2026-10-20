// W3C Trace Context propagation that never changes outbound requests by default.
//
// - extract(): always. An incoming request that carries a traceparent (e.g. a
//   browser fetch whose app sets one) continues that trace, so browser and
//   server spans share a trace id.
// - inject(): only into array carriers unless outbound propagation is enabled.
//   Next.js uses an array carrier solely to render <meta name="traceparent">
//   (experimental.clientTraceMetadata); outbound HTTP header carriers are
//   objects and are left untouched.
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export class DevCompanionPropagator {
  /** @param {{ propagateToOutbound?: boolean }} [options] */
  constructor(options = {}) {
    this.inner = new W3CTraceContextPropagator();
    this.outbound = options.propagateToOutbound === true;
  }

  inject(context, carrier, setter) {
    if (this.outbound || Array.isArray(carrier)) this.inner.inject(context, carrier, setter);
  }

  extract(context, carrier, getter) {
    return this.inner.extract(context, carrier, getter);
  }

  fields() {
    return this.inner.fields();
  }
}
