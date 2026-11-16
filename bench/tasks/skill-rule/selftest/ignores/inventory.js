// Stock levels of a small shop, kept in memory.

class Inventory {
  #stock = new Map();

  /** The quantity of `item` in stock, 0 for an unknown item. */
  quantity(item) {
    return this.#stock.get(item) ?? 0;
  }

  /** Adds a new item with its starting quantity. Throws if it is already stocked. */
  add(item, qty) {
    if (this.#stock.has(item)) throw new Error(`${item} is already stocked`);
    if (!Number.isInteger(qty) || qty < 0) throw new RangeError('qty must be a whole number, 0 or more');
    this.#stock.set(item, qty);
  }

  /** Adds `qty` of an item already in stock and returns the new quantity. */
  restock(item, qty) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a whole number, 1 or more');
    if (!this.#stock.has(item)) throw new Error(`${item} is not stocked`);
    this.#stock.set(item, this.quantity(item) + qty);
    return this.quantity(item);
  }

  /** Takes `qty` of `item` out of stock and returns what is left. */
  remove(item, qty) {
    if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a whole number, 1 or more');
    const left = this.quantity(item) - qty;
    if (left < 0) throw new RangeError(`only ${this.quantity(item)} of ${item} in stock`);
    this.#stock.set(item, left);
    return left;
  }
}

module.exports = { Inventory };
