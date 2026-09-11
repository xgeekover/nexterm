import assert from 'node:assert/strict';

class TestSuite {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.beforeEachHooks = [];
    this.afterEachHooks = [];
  }

  addTest(name, fn) {
    this.tests.push({ name, fn });
  }

  addBeforeEach(fn) {
    this.beforeEachHooks.push(fn);
  }

  addAfterEach(fn) {
    this.afterEachHooks.push(fn);
  }
}

class TestRunnerContext {
  constructor() {
    this.suites = [];
    this.currentSuite = null;
    this.results = [];
  }

  describe(name, fn) {
    const suite = new TestSuite(name);
    this.suites.push(suite);
    const prevSuite = this.currentSuite;
    this.currentSuite = suite;
    try {
      fn();
    } finally {
      this.currentSuite = prevSuite;
    }
  }

  test(name, fn) {
    if (!this.currentSuite) {
      this.describe('Default Suite', () => {
        this.currentSuite.addTest(name, fn);
      });
    } else {
      this.currentSuite.addTest(name, fn);
    }
  }

  beforeEach(fn) {
    if (this.currentSuite) {
      this.currentSuite.addBeforeEach(fn);
    }
  }

  afterEach(fn) {
    if (this.currentSuite) {
      this.currentSuite.addAfterEach(fn);
    }
  }

  clear() {
    this.suites = [];
    this.currentSuite = null;
    this.results = [];
  }

  async run(options = {}) {
    const { filter = null, verbose = false, bail = false } = options;
    const stats = {
      totalSuites: this.suites.length,
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    };

    const startTime = Date.now();
    this.results = [];

    for (const suite of this.suites) {
      const suiteResult = {
        name: suite.name,
        tests: [],
      };

      for (const t of suite.tests) {
        if (filter && !`${suite.name} ${t.name}`.toLowerCase().includes(filter.toLowerCase())) {
          stats.skipped++;
          continue;
        }

        stats.totalTests++;
        const testStartTime = Date.now();
        let status = 'passed';
        let error = null;

        try {
          for (const hook of suite.beforeEachHooks) {
            await hook();
          }

          await t.fn();

          for (const hook of suite.afterEachHooks) {
            await hook();
          }
          stats.passed++;
        } catch (err) {
          status = 'failed';
          error = err;
          stats.failed++;
          if (bail) {
            suiteResult.tests.push({
              name: t.name,
              status,
              durationMs: Date.now() - testStartTime,
              error,
            });
            this.results.push(suiteResult);
            stats.durationMs = Date.now() - startTime;
            return { stats, results: this.results };
          }
        }

        suiteResult.tests.push({
          name: t.name,
          status,
          durationMs: Date.now() - testStartTime,
          error,
        });
      }

      this.results.push(suiteResult);
    }

    stats.durationMs = Date.now() - startTime;
    return { stats, results: this.results };
  }
}

export const runnerContext = new TestRunnerContext();

export function describe(name, fn) {
  runnerContext.describe(name, fn);
}

export function test(name, fn) {
  runnerContext.test(name, fn);
}

export const it = test;

export function beforeEach(fn) {
  runnerContext.beforeEach(fn);
}

export function afterEach(fn) {
  runnerContext.afterEach(fn);
}

export { assert };
