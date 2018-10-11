import { Scope } from '@sentry/hub';
import {
  Breadcrumb,
  Integration,
  SentryBreadcrumbHint,
  SentryEvent,
  SentryEventHint,
  SentryResponse,
  SentryWrappedFunction,
  Severity,
  Status,
} from '@sentry/types';
import { forget } from '@sentry/utils/async';
import { getGlobalObject, uuid4 } from '@sentry/utils/misc';
import { truncate } from '@sentry/utils/string';
import { BackendClass } from './basebackend';
import { Dsn } from './dsn';
import { IntegrationIndex, setupIntegrations } from './integrations';
import { Backend, Client, Options } from './interfaces';
import { logger } from './logger';

/** JSDoc */
interface ExtensibleConsole extends Console {
  [key: string]: any;
}

/** JSDoc */
async function beforeBreadcrumbConsoleLoopGuard(
  callback: () => Breadcrumb | Promise<Breadcrumb | null> | null,
): Promise<Breadcrumb | null> {
  const global = getGlobalObject() as Window;
  const levels = ['debug', 'info', 'warn', 'error', 'log'];

  if (!('console' in global)) {
    return callback();
  }

  const originalConsole = global.console as ExtensibleConsole;

  // Restore all wrapped console methods
  levels.forEach(level => {
    if (level in global.console && (originalConsole[level] as SentryWrappedFunction).__sentry__) {
      originalConsole[level] = (originalConsole[level] as SentryWrappedFunction).__sentry_original__;
    }
  });

  // Perform callback manipulations
  const result = await callback();

  // Revert restoration to wrapped state
  levels.forEach(level => {
    if (level in global.console && (originalConsole[level] as SentryWrappedFunction).__sentry__) {
      originalConsole[level] = (originalConsole[level] as SentryWrappedFunction).__sentry_wrapped__;
    }
  });

  return result;
}

/**
 * Default maximum number of breadcrumbs added to an event. Can be overwritten
 * with {@link Options.maxBreadcrumbs}.
 */
const DEFAULT_BREADCRUMBS = 30;

/**
 * Absolute maximum number of breadcrumbs added to an event. The
 * `maxBreadcrumbs` option cannot be higher than this value.
 */
const MAX_BREADCRUMBS = 100;

/**
 * By default, truncates URL values to 250 chars
 */
const MAX_URL_LENGTH = 250;

/**
 * Base implementation for all JavaScript SDK clients.
 *
 * Call the constructor with the corresponding backend constructor and options
 * specific to the client subclass. To access these options later, use
 * {@link Client.getOptions}. Also, the Backend instance is available via
 * {@link Client.getBackend}.
 *
 * If a Dsn is specified in the options, it will be parsed and stored. Use
 * {@link Client.getDsn} to retrieve the Dsn at any moment. In case the Dsn is
 * invalid, the constructor will throw a {@link SentryException}. Note that
 * without a valid Dsn, the SDK will not send any events to Sentry.
 *
 * Before sending an event via the backend, it is passed through
 * {@link BaseClient.prepareEvent} to add SDK information and scope data
 * (breadcrumbs and context). To add more custom information, override this
 * method and extend the resulting prepared event.
 *
 * To issue automatically created events (e.g. via instrumentation), use
 * {@link Client.captureEvent}. It will prepare the event and pass it through
 * the callback lifecycle. To issue auto-breadcrumbs, use
 * {@link Client.addBreadcrumb}.
 *
 * @example
 * class NodeClient extends BaseClient<NodeBackend, NodeOptions> {
 *   public constructor(options: NodeOptions) {
 *     super(NodeBackend, options);
 *   }
 *
 *   // ...
 * }
 */
export abstract class BaseClient<B extends Backend, O extends Options> implements Client<O> {
  /**
   * The backend used to physically interact in the enviornment. Usually, this
   * will correspond to the client. When composing SDKs, however, the Backend
   * from the root SDK will be used.
   */
  private readonly backend: B;

  /** Options passed to the SDK. */
  private readonly options: O;

  /**
   * The client Dsn, if specified in options. Without this Dsn, the SDK will be
   * disabled.
   */
  private readonly dsn?: Dsn;

  /**
   * Stores whether installation has been performed and was successful. Before
   * installing, this is undefined. Then it contains the success state.
   */
  private installed?: boolean;

  /** Array of used integrations. */
  private integrations?: IntegrationIndex;

  /**
   * Initializes this client instance.
   *
   * @param backendClass A constructor function to create the backend.
   * @param options Options for the client.
   */
  protected constructor(backendClass: BackendClass<B, O>, options: O) {
    this.backend = new backendClass(options);
    this.options = options;

    if (options.dsn) {
      this.dsn = new Dsn(options.dsn);
    }

    this.integrations = setupIntegrations(options);
  }

  /**
   * @inheritDoc
   */
  public install(): boolean {
    if (!this.isEnabled()) {
      return (this.installed = false);
    }

    const backend = this.getBackend();
    if (!this.installed && backend.install) {
      backend.install();
    }

    return (this.installed = true);
  }

  /**
   * Internal helper function to buffer promises.
   *
   * @param promise Any promise, but in this case Promise<SentryResponse>.
   */
  protected async buffer(promise: Promise<SentryResponse>): Promise<SentryResponse> {
    return this.getBackend()
      .getBuffer()
      .add(promise);
  }

  /**
   * @inheritDoc
   */
  public async captureException(exception: any, hint?: SentryEventHint, scope?: Scope): Promise<SentryResponse> {
    return this.buffer(
      (async () => {
        const event = await this.getBackend().eventFromException(exception, hint);
        return this.captureEvent(event, hint, scope);
      })(),
    );
  }

  /**
   * @inheritDoc
   */
  public async captureMessage(
    message: string,
    level?: Severity,
    hint?: SentryEventHint,
    scope?: Scope,
  ): Promise<SentryResponse> {
    return this.buffer(
      (async () => {
        const event = await this.getBackend().eventFromMessage(message, level, hint);
        return this.captureEvent(event, hint, scope);
      })(),
    );
  }

  /**
   * @inheritDoc
   */
  public async captureEvent(event: SentryEvent, hint?: SentryEventHint, scope?: Scope): Promise<SentryResponse> {
    // Adding this here is technically not correct since if you call captureMessage/captureException it's already
    // buffered. But since we not really need the count and we only need to know if the buffer is full or not,
    // This is fine...
    return this.buffer(
      (async () =>
        this.processEvent(event, async finalEvent => this.getBackend().sendEvent(finalEvent), hint, scope))(),
    );
  }

  /**
   * @inheritDoc
   */
  public async addBreadcrumb(breadcrumb: Breadcrumb, hint?: SentryBreadcrumbHint, scope?: Scope): Promise<void> {
    const { beforeBreadcrumb, maxBreadcrumbs = DEFAULT_BREADCRUMBS } = this.getOptions();

    if (maxBreadcrumbs <= 0) {
      return;
    }

    const timestamp = new Date().getTime() / 1000;
    const mergedBreadcrumb = { timestamp, ...breadcrumb };
    const finalBreadcrumb = beforeBreadcrumb
      ? await beforeBreadcrumbConsoleLoopGuard(() => beforeBreadcrumb(mergedBreadcrumb, hint))
      : mergedBreadcrumb;

    if (finalBreadcrumb === null) {
      return;
    }

    if ((await this.getBackend().storeBreadcrumb(finalBreadcrumb)) && scope) {
      scope.addBreadcrumb(finalBreadcrumb, Math.min(maxBreadcrumbs, MAX_BREADCRUMBS));
    }
  }

  /**
   * @inheritDoc
   */
  public getDsn(): Dsn | undefined {
    return this.dsn;
  }

  /**
   * @inheritDoc
   */
  public getOptions(): O {
    return this.options;
  }

  /** Returns the current backend. */
  protected getBackend(): B {
    return this.backend;
  }

  /** Determines whether this SDK is enabled and a valid Dsn is present. */
  protected isEnabled(): boolean {
    return this.getOptions().enabled !== false && this.dsn !== undefined;
  }

  /**
   * Adds common information to events.
   *
   * The information includes release and environment from `options`,
   * breadcrumbs and context (extra, tags and user) from the scope.
   *
   * Information that is already present in the event is never overwritten. For
   * nested objects, such as the context, keys are merged.
   *
   * @param event The original event.
   * @param hint May contain additional informartion about the original exception.
   * @param scope A scope containing event metadata.
   * @returns A new event with more information.
   */
  protected async prepareEvent(event: SentryEvent, scope?: Scope, hint?: SentryEventHint): Promise<SentryEvent | null> {
    const { environment, maxBreadcrumbs = DEFAULT_BREADCRUMBS, release, dist } = this.getOptions();

    const prepared = { ...event };
    if (prepared.environment === undefined && environment !== undefined) {
      prepared.environment = environment;
    }
    if (prepared.release === undefined && release !== undefined) {
      prepared.release = release;
    }

    if (prepared.dist === undefined && dist !== undefined) {
      prepared.dist = dist;
    }

    if (prepared.message) {
      prepared.message = truncate(prepared.message, MAX_URL_LENGTH);
    }

    const exception = prepared.exception && prepared.exception.values && prepared.exception.values[0];
    if (exception && exception.value) {
      exception.value = truncate(exception.value, MAX_URL_LENGTH);
    }

    const request = prepared.request;
    if (request && request.url) {
      request.url = truncate(request.url, MAX_URL_LENGTH);
    }

    if (prepared.event_id === undefined) {
      prepared.event_id = uuid4();
    }

    // This should be the last thing called, since we want that
    // {@link Hub.addEventProcessor} gets the finished prepared event.
    if (scope) {
      return scope.applyToEvent(prepared, hint, Math.min(maxBreadcrumbs, MAX_BREADCRUMBS));
    }

    return prepared;
  }

  /**
   * Processes an event (either error or message) and sends it to Sentry.
   *
   * This also adds breadcrumbs and context information to the event. However,
   * platform specific meta data (such as the User's IP address) must be added
   * by the SDK implementor.
   *
   * The returned event status offers clues to whether the event was sent to
   * Sentry and accepted there. If the {@link Options.shouldSend} hook returns
   * `false`, the status will be {@link SendStatus.Skipped}. If the rate limit
   * was exceeded, the status will be {@link SendStatus.RateLimit}.
   *
   * @param event The event to send to Sentry.
   * @param send A function to actually send the event.
   * @param scope A scope containing event metadata.
   * @param hint May contain additional informartion about the original exception.
   * @returns A Promise that resolves with the event status.
   */
  protected async processEvent(
    event: SentryEvent,
    send: (finalEvent: SentryEvent) => Promise<SentryResponse>,
    hint?: SentryEventHint,
    scope?: Scope,
  ): Promise<SentryResponse> {
    if (!this.isEnabled()) {
      return {
        status: Status.Skipped,
      };
    }

    const { beforeSend, sampleRate } = this.getOptions();

    // 1.0 === 100% events are sent
    // 0.0 === 0% events are sent
    if (typeof sampleRate === 'number' && Math.random() > sampleRate) {
      return {
        status: Status.Skipped,
      };
    }

    const prepared = await this.prepareEvent(event, scope, hint);
    if (prepared === null) {
      return {
        status: Status.Skipped,
      };
    }

    let finalEvent: SentryEvent | null = prepared;

    try {
      const isInternalException = hint && hint.data && (hint.data as { [key: string]: any }).__sentry__ === true;
      if (!isInternalException && beforeSend) {
        finalEvent = await beforeSend(prepared, hint);
        if ((typeof finalEvent as any) === 'undefined') {
          logger.error('`beforeSend` method has to return `null` or a valid event');
        }
      }
    } catch (exception) {
      forget(
        this.captureException(exception, {
          data: {
            __sentry__: true,
          },
          originalException: exception as Error,
        }),
      );

      return {
        reason: 'Event processing in beforeSend method threw an exception',
        status: Status.Invalid,
      };
    }

    if (finalEvent === null) {
      return {
        reason: 'Event dropped due to being discarded by beforeSend method',
        status: Status.Skipped,
      };
    }

    const response = await send(finalEvent);
    response.event = finalEvent;

    if (response.status === Status.RateLimit) {
      // TODO: Handle rate limits and maintain a queue. For now, we require SDK
      // implementors to override this method and handle it themselves.
    }

    return response;
  }

  /**
   * @inheritDoc
   */
  public async close(timeout?: number): Promise<boolean> {
    return this.getBackend()
      .getBuffer()
      .drain(timeout);
  }

  /**
   * @inheritDoc
   */
  public getIntegration(name: string): Integration | null {
    return (this.integrations && this.integrations[name]) || null;
  }
}
