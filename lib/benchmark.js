/**
 * Benchmark: axios vs undici - HTTP/2 vs HTTP/1.1
 * Compares performance when making concurrent HTTP requests with and without HTTP/2 support
 * Uses concurrent requests to demonstrate HTTP/2 multiplexing advantages
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Disable TLS verification for testingnod

const axiosModule = require('axios');
const { join } = require('path');
const { readFileSync } = require('fs');
const { createSecureServer } = require('http2');
const https = require('https');
const undici = require('undici');
const certPath = join(process.cwd(), '.certs', 'cert.pem');
const keyPath = join(process.cwd(), '.certs', 'key.pem');

const undiciFetch = undici.fetch;

// Extract the axios implementations (handle both default and named exports)
const axios = axiosModule.default || axiosModule;
let http2ServerInstance;
let http1ServerInstance;
const undiciAgentH2 = new undici.Agent({
  allowH2: true,
  connections: 1,
  maxCachedSessions: 10,
  pipelining: 1024,
});
const CONCURRENCY = 300; // Concurrent connections
const TOTAL_REQUESTS = 300; // Total requests per test
const SAMPLING = 40; // Number of runs for statistical significance

/**
 * Create axios instance with standard HTTPS (without specific HTTP/2)
 */
function createAxiosHttp2Client() {
  return axios.create({
    timeout: 15000,
    httpVersion: 2
  });
}

/**
 * Create axios instance with HTTP/1.1 only (no HTTP/2)
 */
function createAxiosHttp1Client() {
  return axios.create({
    timeout: 15000,
    httpVersion: 1,
    headers: {
      connection: 'keep-alive',
    }
  });
}

/**
 * Create undici HTTP/2 client wrapper
 */
function createPureUndiciH2Client() {
  return {
    get: (url) => {
      return undiciFetch(url, {
        method: 'GET',
        dispatcher: undiciAgentH2,
        signal: AbortSignal.timeout(60000),
      }).then((result) => {
        if (!result.ok) throw new Error(`Request failed with status ${result.status}`);
        return result;
      })
        .then((res) => res.text());
    },
  };
}


/**
 * Create undici HTTP/2 client wrapper
 */
function createAbortSinalRequestUndiciH2Client() {
  return {
    get: (url) => {
      return undici.request(url, {
        dispatcher: undiciAgentH2,
        signal: AbortSignal.timeout(60000),
      }).then(({ statusCode, body }) => {
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`Request failed with status ${statusCode}`);
        }
        return body;
      })
        .then(async (res) => {
          return res.text();
      });
    },
  };
}

/**
 * Create undici HTTP/2 client wrapper
 */
function createMinimalUndiciH2Client() {
  return {
    get: (url) => {
      return undiciFetch(url, {
        dispatcher: undiciAgentH2,
      }).then((result) => {
        if (!result.ok) throw new Error(`Request failed with status ${result.status}`);
        return result;
      })
        .then((res) => res.text());
    },
  };
}

/**
 * Create undici HTTP/2 client wrapper using `undici.request`
 */
function createRequestUndiciH2Client() {
  return {
    get: async (url) => {
      return undici.request(url, {
        dispatcher: undiciAgentH2,
      }).then(({ statusCode, body }) => {
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`Request failed with status ${statusCode}`);
        }
        return body;
      })
        .then(async (res) => {
          return res.text();
      });
    },
  };
}

/**
 * Create undici HTTP/1.1 client wrapper
 */
function createPureUndiciH1Client() {
  return {
    get: (url) => {
      return undiciFetch(url, {
        method: 'GET',
        headers: new Headers({
          Connection: 'keep-alive',
        }),
        signal: AbortSignal.timeout(60000),
      }).then((result) => {
        if (!result.ok) throw new Error(`Request failed with status ${result.status}`);
        return result;
      })
        .then((res) => res.text());
    },
  };
}

let http2BaseURLValue;
async function waitForHttp2Server() {
  // If server already initialized, return baseURL
  if (http2BaseURLValue) {
    return http2BaseURLValue;
  }

  return await new Promise((resolve, reject) => {
    try {

      const options = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        // Explicitly enable ALPNProtocols
        ALPNProtocols: ['h2'],
      };

      const server = createSecureServer(options, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Test-Header', 'test-value-http2');
        res.writeHead(200);
        res.end(JSON.stringify({ protocol: 'h2', success: true }));
      });

      server.listen(0, 'localhost', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          const port = addr.port;
          http2BaseURLValue = `https://localhost:${port}`;
          http2ServerInstance = server;
          resolve(http2BaseURLValue);
        } else {
          reject(new Error('Failed to get HTTP/2 server address'));
        }
      });

      server.on('error', (err) => {
        console.error('HTTP/2 Server error:', err);
        reject(err);
      });
    } catch (error) {
      console.error('HTTP/2 Server setup error:', error);
      reject(error);
    }
  });
}

let http1BaseURLValue;
async function waitForHttp1Server() {
  // If server already initialized, return baseURL
  if (http1BaseURLValue) {
    return http1BaseURLValue;
  }

  return await new Promise((resolve, reject) => {
    try {
      const options = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      };

      const server = https.createServer(options, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Test-Header', 'test-value-http1');
        res.writeHead(200);
        res.end(JSON.stringify({ protocol: 'http/1.1', success: true }));
      });

      server.listen(0, 'localhost', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          const port = addr.port;
          http1BaseURLValue = `https://localhost:${port}`;
          http1ServerInstance = server;
          resolve(http1BaseURLValue);
        } else {
          reject(new Error('Failed to get HTTP/1.1 server address'));
        }
      });

      server.on('error', (err) => {
        console.error('HTTP/1.1 Server error:', err);
        reject(err);
      });
    } catch (error) {
      console.error('HTTP/1.1 Server setup error:', error);
      reject(error);
    }
  });
}

/**
 * Run concurrent requests and measure performance with timeout
 */
async function runConcurrentBenchmark(client, concurrency, totalRequests, url) {
  const results = [];
  const startTotal = performance.now();

  // Create batches for concurrent execution
  for (let i = 0; i < totalRequests; i += concurrency) {
    const batch = [];
    for (let j = 0; j < concurrency && i + j < totalRequests; j++) {
      batch.push(
        (async () => {
          const start = performance.now();
          await client.get(url);
          const time = performance.now() - start;
          results.push({ success: true, time });
        })(),
      );
    }
    const batchResult = await Promise.allSettled(batch);
    // Log any rejections
    for (const result of batchResult) {
      if (result.status === 'rejected') {
        console.error('Request failed:', result.reason);
      }
    }
  }

  const totalTime = performance.now() - startTotal;
  return { results, totalTime };
}

/**
 * Run benchmark multiple times and return median result
 */
async function runBenchmarkMultipleTimes(client, concurrency, totalRequests, url, runs = SAMPLING) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const { totalTime } = await runConcurrentBenchmark(client, concurrency, totalRequests, url);
    times.push(totalTime);
    // Cool down between runs
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const stdDev = Math.sqrt(times.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / times.length);

  return { times, median, avg, stdDev };
}

/**
 * Warm up a client to establish connections and cache
 */
async function warmupClient(client, url) {
  // Make multiple rounds to stabilize JIT compilation
  console.log('    Warming up...');
  for (let i = 0; i < 5; i++) {
    await runConcurrentBenchmark(client, CONCURRENCY / 2, CONCURRENCY, url); // Warm up with small batches
  }
}

/**
 * Run the complete benchmark
 */
async function runBenchmark() {
  console.log(
    '🚀 Starting HTTP/2 vs HTTP/1.1 benchmark with concurrent requests...\n',
  );

  // Start both servers
  const API_URL_HTTP2 = await waitForHttp2Server();
  const API_URL_HTTP1 = await waitForHttp1Server();

  console.log(`HTTP/2 Server: ${API_URL_HTTP2}`);
  console.log(`HTTP/1.1 Server: ${API_URL_HTTP1}`);
  console.log(`Total requests: ${TOTAL_REQUESTS}`);
  console.log(`Concurrent connections: ${CONCURRENCY}\n`);

  try {
    // Create all clients
    const axiosHttp2Client = createAxiosHttp2Client();
    const axiosHttp1Client = createAxiosHttp1Client();
    const pureUndiciH2Client = createPureUndiciH2Client();
    const minimalUndiciH2Client = createMinimalUndiciH2Client();
    const requestUndiciH2Client = createRequestUndiciH2Client();
    const abortUndiciH2Client = createAbortSinalRequestUndiciH2Client();
    const pureUndiciH1Client = createPureUndiciH1Client();

    // Warm up all clients
    console.log('🔥 Warming up clients...');
    await warmupClient(axiosHttp2Client, API_URL_HTTP2);
    await warmupClient(axiosHttp1Client, API_URL_HTTP1);
    await warmupClient(pureUndiciH2Client, API_URL_HTTP2);
    await warmupClient(minimalUndiciH2Client, API_URL_HTTP2);
    await warmupClient(requestUndiciH2Client, API_URL_HTTP2);
    await warmupClient(abortUndiciH2Client, API_URL_HTTP2);
    await warmupClient(pureUndiciH1Client, API_URL_HTTP1);
    console.log('✓ Warm up complete\n');

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark axios with HTTP/2
    console.log(`📊 Running axios with HTTP/2 benchmark (${SAMPLING} runs)...`);
    const axiosHttp2Data = await runBenchmarkMultipleTimes(
      axiosHttp2Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP2,
      SAMPLING,
    );
    const axiosHttp2Summary = `axios HTTP/2 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${axiosHttp2Data.median.toFixed(2)}ms
  ├─ Average time: ${axiosHttp2Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${axiosHttp2Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${axiosHttp2Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (axiosHttp2Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark axios with HTTP/1.1
    console.log(`📊 Running axios with HTTP/1.1 benchmark (${SAMPLING} runs)...`);
    const axiosHttp1Data = await runBenchmarkMultipleTimes(
      axiosHttp1Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP1,
      SAMPLING,
    );
    const axiosHttp1Summary = `axios HTTP/1.1 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${axiosHttp1Data.median.toFixed(2)}ms
  ├─ Average time: ${axiosHttp1Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${axiosHttp1Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${axiosHttp1Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (axiosHttp1Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark undici with HTTP/2 (fetch dispatcher)
    console.log(`📊 Running undici with HTTP/2 benchmark (${SAMPLING} runs)...`);
    const pureUndiciH2Data = await runBenchmarkMultipleTimes(
      pureUndiciH2Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP2,
      SAMPLING,
    );
    const pureUndiciH2Summary = `undici (fetch) HTTP/2 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${pureUndiciH2Data.median.toFixed(2)}ms
  ├─ Average time: ${pureUndiciH2Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${pureUndiciH2Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${pureUndiciH2Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (pureUndiciH2Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark undici (minimal) with HTTP/2
    console.log(`📊 Running undici (minimal) with HTTP/2 benchmark (${SAMPLING} runs)...`);
    const minimalUndiciH2Data = await runBenchmarkMultipleTimes(
      minimalUndiciH2Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP2,
      SAMPLING,
    );
    const minimalUndiciH2Summary = `undici (minimal) HTTP/2 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${minimalUndiciH2Data.median.toFixed(2)}ms
  ├─ Average time: ${minimalUndiciH2Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${minimalUndiciH2Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${minimalUndiciH2Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (minimalUndiciH2Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark undici (request) with HTTP/2
    console.log(`📊 Running undici (request) with HTTP/2 benchmark (${SAMPLING} runs)...`);
    const requestUndiciH2Data = await runBenchmarkMultipleTimes(
      requestUndiciH2Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP2,
      SAMPLING,
    );
    const requestUndiciH2Summary = `undici (request) HTTP/2 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${requestUndiciH2Data.median.toFixed(2)}ms
  ├─ Average time: ${requestUndiciH2Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${requestUndiciH2Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${requestUndiciH2Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (requestUndiciH2Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark undici (abortSignal) with HTTP/2
    console.log(`📊 Running undici (request + abortSignal) with HTTP/2 benchmark (${SAMPLING} runs)...`);
    const abortUndiciH2Data = await runBenchmarkMultipleTimes(
      abortUndiciH2Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP2,
      SAMPLING,
    );
    const abortUndiciH2Summary = `undici (request + abortSignal) HTTP/2 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${abortUndiciH2Data.median.toFixed(2)}ms
  ├─ Average time: ${abortUndiciH2Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${abortUndiciH2Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${abortUndiciH2Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (abortUndiciH2Data.median / 1000)).toFixed(2)}`;

    // Wait between tests
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Benchmark undici with HTTP/1.1
    console.log(`📊 Running undici with HTTP/1.1 benchmark (${SAMPLING} runs)...`);
    const pureUndiciH1Data = await runBenchmarkMultipleTimes(
      pureUndiciH1Client,
      CONCURRENCY,
      TOTAL_REQUESTS,
      API_URL_HTTP1,
      SAMPLING,
    );
    const pureUndiciH1Summary = `undici HTTP/1.1 Results (median of ${SAMPLING} runs):
  ├─ Total requests per run: ${TOTAL_REQUESTS}
  ├─ Median time: ${pureUndiciH1Data.median.toFixed(2)}ms
  ├─ Average time: ${pureUndiciH1Data.avg.toFixed(2)}ms
  ├─ Std Dev: ${pureUndiciH1Data.stdDev.toFixed(2)}ms
  ├─ All runs: [${pureUndiciH1Data.times.map((t) => t.toFixed(2)).join(', ')}]ms
  └─ Requests/sec (median): ${(TOTAL_REQUESTS / (pureUndiciH1Data.median / 1000)).toFixed(2)}`;

    console.log('\n📈 Summary:\n');
    console.log('\n');
    console.log(axiosHttp2Summary);
    console.log('\n');
    console.log(axiosHttp1Summary);
    console.log('\n');
    console.log(pureUndiciH2Summary);
    console.log('\n');
    console.log(minimalUndiciH2Summary);
    console.log('\n');
    console.log(requestUndiciH2Summary);
    console.log('\n');
    console.log(abortUndiciH2Summary);
    console.log('\n');
    console.log(pureUndiciH1Summary);

    // Calculate comparisons
    console.log('\n\n📊 Comparisons (using median times):\n');
    console.log('\n--- axios HTTP/2 vs HTTP/1.1 ---');
    const axiosImprovement =
      ((axiosHttp1Data.median - axiosHttp2Data.median) /
        axiosHttp1Data.median) *
      100;
    console.log(
      `  ${axiosImprovement > 0 ? '✓' : '✗'} HTTP/2 is ${Math.abs(axiosImprovement).toFixed(2)}% ${axiosImprovement > 0 ? 'faster' : 'slower'}`,
    );

    console.log('\n--- undici (pure) vs axios (HTTP/2) ---');
    const undiciPureVsAxios = ((axiosHttp2Data.median - pureUndiciH2Data.median) / axiosHttp2Data.median) * 100;
    console.log(`  ${undiciPureVsAxios > 0 ? '✓' : '✗'} undici (fetch) is ${Math.abs(undiciPureVsAxios).toFixed(2)}% ${undiciPureVsAxios > 0 ? 'faster' : 'slower'}`);

    console.log('\n--- undici (minimal) vs axios (HTTP/2) ---');
    const undiciMinimalVsAxios = ((axiosHttp2Data.median - minimalUndiciH2Data.median) / axiosHttp2Data.median) * 100;
    console.log(`  ${undiciMinimalVsAxios > 0 ? '✓' : '✗'} undici (minimal) is ${Math.abs(undiciMinimalVsAxios).toFixed(2)}% ${undiciMinimalVsAxios > 0 ? 'faster' : 'slower'}`);

    console.log('\n--- undici (request) vs axios (HTTP/2) ---');
    const undiciRequestVsAxios = ((axiosHttp2Data.median - requestUndiciH2Data.median) / axiosHttp2Data.median) * 100;
    console.log(`  ${undiciRequestVsAxios > 0 ? '✓' : '✗'} undici (request) is ${Math.abs(undiciRequestVsAxios).toFixed(2)}% ${undiciRequestVsAxios > 0 ? 'faster' : 'slower'}`);

    console.log('\n--- undici (request + abortSignal) vs axios (HTTP/2) ---');
    const undiciAbortVsAxios = ((axiosHttp2Data.median - abortUndiciH2Data.median) / axiosHttp2Data.median) * 100;
    console.log(`  ${undiciAbortVsAxios > 0 ? '✓' : '✗'} undici (request + abortSignal) is ${Math.abs(undiciAbortVsAxios).toFixed(2)}% ${undiciAbortVsAxios > 0 ? 'faster' : 'slower'}`);

    console.log('\n--- Ranking (HTTP/2 only, median times) ---');
    const http2Results = [
      { name: 'axios', time: axiosHttp2Data.median, stdDev: axiosHttp2Data.stdDev },
      { name: 'undici (fetch)', time: pureUndiciH2Data.median, stdDev: pureUndiciH2Data.stdDev },
      { name: 'undici (minimal)', time: minimalUndiciH2Data.median, stdDev: minimalUndiciH2Data.stdDev },
      { name: 'undici (request)', time: requestUndiciH2Data.median, stdDev: requestUndiciH2Data.stdDev },
      { name: 'undici (request + abortSignal)', time: abortUndiciH2Data.median, stdDev: abortUndiciH2Data.stdDev },
    ].sort((a, b) => a.time - b.time);

    http2Results.forEach((result, idx) => {
      const percentage = ((result.time - http2Results[0].time) / http2Results[0].time * 100).toFixed(2);
      const marker = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
      console.log(
        `  ${marker} ${idx + 1}. ${result.name}: ${result.time.toFixed(2)}ms ±${result.stdDev.toFixed(2)}ms ${idx > 0 ? `(+${percentage}%)` : '(baseline)'}`,
      );
    });

    console.log('\n--- Ranking (HTTP/1.1 only, median times) ---');
    const http1Results = [
      { name: 'axios', time: axiosHttp1Data.median, stdDev: axiosHttp1Data.stdDev },
      { name: 'undici (fetch)', time: pureUndiciH1Data.median, stdDev: pureUndiciH1Data.stdDev },
    ].sort((a, b) => a.time - b.time);

    http1Results.forEach((result, idx) => {
      const percentage = ((result.time - http1Results[0].time) / http1Results[0].time * 100).toFixed(2);
      const marker = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
      console.log(
        `  ${marker} ${idx + 1}. ${result.name}: ${result.time.toFixed(2)}ms ±${result.stdDev.toFixed(2)}ms ${idx > 0 ? `(+${percentage}%)` : '(baseline)'}`,
      );
    });

    console.log('\n--- HTTP/2 vs HTTP/1.1 Improvement (per client) ---');
    const clients = [
      { name: 'axios', h2: axiosHttp2Data.median, h1: axiosHttp1Data.median },
      { name: 'undici (fetch)', h2: pureUndiciH2Data.median, h1: pureUndiciH1Data.median },
    ];

    clients.forEach((client) => {
      const improvement = ((client.h1 - client.h2) / client.h1) * 100;
      console.log(`  ${client.name}: ${improvement.toFixed(2)}% faster with HTTP/2 (${client.h2.toFixed(2)}ms vs ${client.h1.toFixed(2)}ms)`);
    });

    console.log('✅ Benchmark completed!\n');
  } catch (error) {
    console.error('❌ Benchmark failed:', error);
  } finally {
    try {
      if (http2ServerInstance) {
        http2ServerInstance.close();
      }
      if (http1ServerInstance) {
        http1ServerInstance.close();
      }
    } catch (cleanupErr) {
      console.error('Error during cleanup:', cleanupErr);
    } finally {
      process.exit(0);
    }
  }
}

runBenchmark();
