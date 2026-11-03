import { register } from './handlers.ts';

register('System:GetMetadata', () => Buffer.alloc(0));

register('System:Check', (_ctx) => {
  return {
    MaintenanceInfo: {},
    ReviewInfo: {},
    KeepAliveTimeMilliseconds: 60_000,
    KeepAliveTimeoutMilliseconds: 5_000,
    EnableCrashlyticsCollection: true,
    EnableUnityLogErrorToLogException: true,
    EnableApiParallelExecutionSuppression: true,
  };
});

// Solis `system/check_app.go`: the client checks in before photo pose shooting;
// the response is an empty `api.Empty`.
register('System:CheckApp', () => Buffer.alloc(0));
