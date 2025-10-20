# React Native + Zustand Gotchas

This document captures critical lessons learned during development to prevent future bugs and infinite loops.

## 🔄 Infinite Loop Issues

### ❌ NEVER: Use Object Destructuring with Zustand Selectors

**Problem**: Object destructuring from Zustand store creates new objects on every render, causing infinite re-render loops.

```typescript
// ❌ BAD - Creates new object every render
const { prop1, prop2, prop3 } = useWalletStore();
const { initialize, wallet } = useWalletStore();
```

**Error Messages You'll See**:
- `ERROR The result of getSnapshot should be cached to avoid an infinite loop`
- `ERROR Maximum update depth exceeded`
- `ErrorBoundary caught an error: Maximum update depth exceeded`

**Solution**: Use individual selectors instead:

```typescript
// ✅ GOOD - Stable references
const prop1 = useWalletStore(state => state.prop1);
const prop2 = useWalletStore(state => state.prop2);
const prop3 = useWalletStore(state => state.prop3);
```

### ❌ NEVER: Return New Objects from Store Selectors

**Problem**: Store selectors that return new objects (even with the same data) cause infinite re-renders.

```typescript
// ❌ BAD - Returns new object every time
export const useBadHook = () =>
  useWalletStore(state => ({
    balance: state.balance,
    isLoading: state.isLoading,
    reload: () => state.loadBalance(),
  }));
```

**Solution**: Use caching to return stable object references:

```typescript
// ✅ GOOD - Cached result with stable references
const resultCache = new Map();

export const useGoodHook = (accountId: string) =>
  useWalletStore(state => {
    const accountState = state.accountStates[accountId];

    // Only create new object if data actually changed
    const cached = resultCache.get(accountId);
    if (cached && cached.accountState === accountState) {
      return cached.result;
    }

    const result = Object.freeze({
      balance: accountState.balance,
      isLoading: accountState.isLoading,
      reload: () => state.loadBalance(accountId),
    });

    resultCache.set(accountId, { accountState, result });
    return result;
  });
```

## 🔢 BigInt and Transaction Amount Issues

### ❌ NEVER: Use Logical OR (`||`) with BigInt Values

**Problem**: Logical OR can coerce BigInt values to numbers, causing precision loss or incorrect fallback behavior.

```typescript
// ❌ BAD - Can coerce BigInt to number
amount: txn['payment-transaction']?.amount || 0
```

**Solution**: Use nullish coalescing (`??`) to preserve BigInt types:

```typescript
// ✅ GOOD - Preserves BigInt values
amount: txn['payment-transaction']?.amount ?? 0
```

### ❌ NEVER: Assume Transaction Data Structure

**Problem**: Algorand transactions have different structures based on type. Assuming a single structure can lead to missing data.

```typescript
// ❌ BAD - Misses type-specific data
amount: txn['payment-transaction']?.amount || txn['asset-transfer-transaction']?.amount || 0
```

**Solution**: Explicitly check transaction types:

```typescript
// ✅ GOOD - Type-specific extraction
let amount: number | bigint = 0;
if (txn['tx-type'] === 'pay' && txn['payment-transaction']) {
  amount = txn['payment-transaction'].amount ?? 0;
} else if (txn['tx-type'] === 'axfer' && txn['asset-transfer-transaction']) {
  amount = txn['asset-transfer-transaction'].amount ?? 0;
}
```

## 🎯 Async Function Issues

### ❌ NEVER: Use `await` in Non-Async Functions

**Problem**: Using `await` without marking the function as `async` causes syntax errors.

```typescript
// ❌ BAD - Syntax error
const resetForm = () => {
  // ...
  await Promise.allSettled([reloadBalance()]);
};
```

**Solution**: Mark functions as `async` and handle async calls in event handlers properly:

```typescript
// ✅ GOOD - Properly marked as async
const resetForm = async () => {
  // ...
  await Promise.allSettled([reloadBalance()]);
};

// ✅ GOOD - Non-blocking call in event handler
onPress: () => { resetForm(); }
```

## 🛡️ Best Practices to Follow

### 1. Store Selectors
- Always use individual selectors: `useStore(state => state.prop)`
- Never destructure: `const { prop } = useStore()`
- Cache objects returned from selectors using Maps or module-level variables
- Use `Object.freeze()` on cached objects to ensure immutability

### 2. Type Safety with BigInt
- Use `number | bigint` types for Algorand amounts
- Prefer nullish coalescing (`??`) over logical OR (`||`)
- Always handle both number and BigInt cases in utility functions

### 3. Async Operations
- Mark functions as `async` when using `await`
- Use non-blocking calls in UI event handlers when appropriate
- Handle Promise rejections with proper error boundaries

### 4. Transaction Parsing
- Always check transaction type (`tx-type`) before accessing type-specific fields
- Use explicit conditionals rather than chained logical operators
- Preserve original data types (especially BigInt) throughout the parsing chain

## 🔍 Debugging Tips

### Identifying Infinite Loops
1. Look for "getSnapshot should be cached" errors
2. Check for object destructuring from store hooks
3. Use React DevTools Profiler to find components that re-render constantly
4. Add console.logs to selectors to see if they're being called repeatedly

### Finding BigInt Issues
1. Check for `|| 0` patterns in amount handling
2. Look for missing `??` operators with algosdk responses
3. Verify type annotations include `bigint` where needed
4. Test with large transaction amounts that would expose precision issues

## 🚨 Code Review Checklist

Before merging any PR, check for:

- [ ] No object destructuring from Zustand store hooks
- [ ] All store selectors return stable references
- [ ] Async functions are properly marked with `async` keyword
- [ ] BigInt values use nullish coalescing (`??`) instead of logical OR (`||`)
- [ ] Transaction parsing checks types explicitly
- [ ] No new objects created in store selectors without caching

## 📚 Related Documentation

- [Zustand Best Practices](https://docs.pmnd.rs/zustand/guides/prevent-rerenders-with-use-shallow)
- [React 18 Strict Mode](https://react.dev/reference/react/StrictMode)
- [Algorand Transaction Types](https://developer.algorand.org/docs/get-details/transactions/)
- [BigInt in JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt)

---

*Last Updated: September 2025*
*If you encounter similar issues, please update this document with new learnings.*