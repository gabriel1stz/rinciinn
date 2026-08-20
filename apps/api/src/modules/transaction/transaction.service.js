import { processMessage } from "../../core/message/message.engine.js";
import { executeTransactions } from "../../core/transaction/executor.js";
import { findUserByPhone, createTrialUser } from "../user/user.service.js";
import { checkBudget } from "../budget/budget.service.js";
import { findWalletByName, findWalletById, adjustWalletBalanceTx } from "../wallet/repositories/wallet.repository.js";
import { findOrCreateCategory } from "../category/repositories/category.repository.js";
import { transactionRepository } from "../../lib/TransactionRepository.js";
import {
  findTransactionsByPhone,
  findRecentTransactions,
  findTransactions,
  findById,
  createTransaction,
  createTransactionTx,
  updateTransaction,
  updateTransactionTx,
  deleteTransactionById,
  deleteTransactionByIdTx,
  restoreTransactionByIdTx,
  findTransactionsWithFilters,
} from "./repositories/transaction.repository.js";

export async function processTransactionMessage(phone, message, name = null) {
  let user = await findUserByPhone(phone);

  if (!user) {
    user = await createTrialUser(phone, name);
  }

  const processed = await processMessage(message);

  if (processed.intent !== "CREATE_TRANSACTION") {
    return {
      type: "NON_TRANSACTION",
      intent: processed.intent,
      result: processed
    };
  }

  const transactionsToSave = processed.data?.transactions || [];

  if (transactionsToSave.length === 0) {
    return {
      type: "NON_TRANSACTION",
      intent: "UNKNOWN",
      text: "❌ Tidak dapat mengenali detail nominal atau transaksi. Contoh format: *makan 25rb gopay* atau *kopi 30rb bca*"
    };
  }

  const result = await executeTransactions(
    user,
    transactionsToSave
  );

  let budget = null;

  if (transactionsToSave.length === 1) {
    budget = await checkBudget(
      user.id,
      transactionsToSave[0].categoryName
    );
  }

  return {
    type: "TRANSACTION_SAVED",
    count: result.savedTransactions.length,
    transactions: result.savedTransactions,
    wallets: result.updatedWallets,
    budget
  };
}

export async function getTransactionHistory(phone, limit = 20) {
  return findTransactionsByPhone(phone, limit);
}

export async function getRecentTransactions(phone, limit = 10) {
  return findRecentTransactions(phone, limit);
}

export async function searchTransactions(phone, filter, userId = null) {
  return findTransactions({
    phone,
    userId,
    ...filter
  });
}


export async function getTransactionById(userId, id, includeDeleted = false) {
  const transaction = await findById(id, includeDeleted);

  if (!transaction) {
    throw new Error("Transaksi tidak ditemukan");
  }

  if (transaction.userId !== userId) {
    throw new Error("Unauthorized");
  }

  return transaction;
}

export async function createRestTransaction(userId, data, auditFn) {
  const wallet = await findWalletByName(userId, data.walletName);

  if (!wallet) {
    throw new Error("Wallet tidak ditemukan");
  }

  if (wallet.archived) {
    throw new Error("Wallet sudah diarsipkan");
  }

  if (data.type === "EXPENSE" && wallet.balance < data.amount) {
    throw new Error("Saldo tidak cukup");
  }

  const category = await findOrCreateCategory(data.categoryName, data.type);
  const balanceAdjustment = data.type === "INCOME" ? data.amount : -data.amount;

  return transactionRepository.transaction(async (tx) => {
    const transaction = await createTransactionTx(tx, userId, {
      walletId: wallet.id,
      categoryId: category.id,
      type: data.type,
      amount: data.amount,
      description: data.description,
      note: data.note,
      date: data.date,
      receiptUrl: data.receiptUrl,
      tags: data.tags,
    });

    await adjustWalletBalanceTx(tx, wallet.id, balanceAdjustment);

    if (auditFn) {
      await auditFn({
        action: "CREATE_TRANSACTION",
        entityType: "Transaction",
        entityId: transaction.id,
        after: { amount: Number(transaction.amount), type: transaction.type, walletId: transaction.walletId },
      });
    }

    return transaction;
  });
}

export async function updateRestTransaction(userId, id, data, auditFn) {
  const existing = await getTransactionById(userId, id);
  let newWalletId = data.walletId || existing.walletId;
  let newAmount = data.amount !== undefined ? Number(data.amount) : Number(existing.amount);
  let newType = data.type || existing.type;

  const oldBalanceEffect = existing.type === "INCOME"
    ? -Number(existing.amount)
    : Number(existing.amount);

  const newBalanceEffect = newType === "INCOME" ? newAmount : -newAmount;

  return transactionRepository.transaction(async (tx) => {
    await adjustWalletBalanceTx(tx, existing.walletId, oldBalanceEffect);

    if (newWalletId !== existing.walletId) {
      const newWallet = await findWalletById(newWalletId);
      if (!newWallet) throw new Error("Wallet baru tidak ditemukan");
      await adjustWalletBalanceTx(tx, newWalletId, newBalanceEffect);
    } else {
      await adjustWalletBalanceTx(tx, existing.walletId, newBalanceEffect);
    }

    const updated = await updateTransactionTx(tx, id, {
      ...data,
      walletId: newWalletId,
      amount: newAmount,
      type: newType,
    });

    if (auditFn) {
      await auditFn({
        action: "UPDATE_TRANSACTION",
        entityType: "Transaction",
        entityId: id,
        before: { amount: Number(existing.amount), type: existing.type, walletId: existing.walletId },
        after: { amount: Number(newAmount), type: newType, walletId: newWalletId },
      });
    }

    return updated;
  });
}

export async function deleteRestTransaction(userId, id, auditFn) {
  const transaction = await getTransactionById(userId, id, true);

  const balanceEffect = transaction.type === "INCOME"
    ? -Number(transaction.amount)
    : Number(transaction.amount);

  return transactionRepository.transaction(async (tx) => {
    await adjustWalletBalanceTx(tx, transaction.walletId, balanceEffect);
    await deleteTransactionByIdTx(tx, id);

    if (auditFn) {
      await auditFn({
        action: "DELETE_TRANSACTION",
        entityType: "Transaction",
        entityId: id,
        before: { amount: Number(transaction.amount), type: transaction.type, walletId: transaction.walletId },
        metadata: { balanceEffect: Number(balanceEffect) },
      });
    }

    return transaction;
  });
}

export async function restoreRestTransaction(userId, id, auditFn) {
  const transaction = await findById(id, true);
  if (!transaction) throw new Error("Transaksi tidak ditemukan");
  if (transaction.userId !== userId) throw new Error("Unauthorized");
  if (!transaction.deletedAt) throw new Error("Transaksi tidak dalam status terhapus");

  const balanceEffect = transaction.type === "INCOME"
    ? Number(transaction.amount)
    : -Number(transaction.amount);

  return transactionRepository.transaction(async (tx) => {
    await adjustWalletBalanceTx(tx, transaction.walletId, balanceEffect);
    const restored = await restoreTransactionByIdTx(tx, id);

    if (auditFn) {
      await auditFn({
        action: "RESTORE_TRANSACTION",
        entityType: "Transaction",
        entityId: id,
        before: { deletedAt: transaction.deletedAt },
        after: { deletedAt: null },
        metadata: {
          amount: Number(transaction.amount),
          type: transaction.type,
          walletId: transaction.walletId,
          balanceEffect: Number(balanceEffect),
        },
      });
    }

    return restored;
  });
}

export async function listTransactions(userId, query) {
  return findTransactionsWithFilters({
    userId,
    search: query.search,
    type: query.type,
    walletId: query.walletId,
    categoryId: query.categoryId,
    startDate: query.startDate,
    endDate: query.endDate,
    minAmount: query.minAmount,
    maxAmount: query.maxAmount,
    sort: query.sort || "date",
    order: query.order || "desc",
    page: Number(query.page) || 1,
    limit: Number(query.limit) || 20,
  });
}

export async function uploadReceiptRest(userId, id, receiptUrl, auditFn) {
  const transaction = await getTransactionById(userId, id);

  const updated = await updateTransaction(id, { receiptUrl });

  if (auditFn) {
    await auditFn({
      action: "UPLOAD_RECEIPT",
      entityType: "Transaction",
      entityId: id,
      metadata: { receiptUrl },
    });
  }

  return updated;
}
