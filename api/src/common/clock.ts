/** Injectable source of "now" so tests and the eval can pin time. */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  constructor(private instant: Date) {
    super();
  }

  now(): Date {
    return new Date(this.instant);
  }

  set(instant: Date): void {
    this.instant = instant;
  }
}
