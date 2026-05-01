export type RestaurantCitySyncResult = {
    city: string;
    created: number;
    updated: number;
    candidates: number;
};
export type RunFetchRestaurantsOptions = {
    /** Called after each metro finishes (same seven cities as the CLI script). */
    onCityComplete?: (result: RestaurantCitySyncResult) => void;
};
/**
 * Fetches top restaurants for Phoenix, Scottsdale, Tempe, Mesa, Glendale, Chandler, and Surprise, AZ.
 */
export declare function runFetchRestaurants(options?: RunFetchRestaurantsOptions): Promise<RestaurantCitySyncResult[]>;
//# sourceMappingURL=fetchRestaurants.d.ts.map